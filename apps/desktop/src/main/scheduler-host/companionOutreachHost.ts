import type { CreateScheduleInput, Schedule, ScheduleRunner } from '@cindy/maker-scheduler';
import { and, desc, eq, gte, inArray, isNull, like } from 'drizzle-orm';
import { COMPANION_FOLLOW_UP_CLIENT_PREFIX } from '../../shared/companionFollowUpMessage.js';
import { untrustedJsonBlock } from '../../shared/untrustedPrompt.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { mirrorMessageText } from '../companion-cloud/mirror.js';
import { mirrorColumns, visibleRows } from '../companion-cloud/turnImages.js';
import {
  captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { readBotSettingsProfile } from '../localDb/ipc/bots.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { buildTextOneshotPinOptions } from '../utility-model/textOneshotPinOptions.js';
import { hasOneshotProviderCredential } from '../utility-model/oneshotProviderUsability.js';
import { withBotProfileLocks } from '../maker-ipc/botProfileLock.js';
import { teammateWorkspaceDir } from '../maker-ipc/botProjectMemory.js';
import {
  ensureSchedulerQueueRestored, getSessionLastUserActionAt,
  isSchedulerTargetSessionBusy, withSendToSessionLock,
} from '../maker-ipc/register.js';
import { requestExplicitUtilityText } from '../utility-model/oneShotCandidates.js';
import { CompanionOutreachLedger } from './companionOutreachLedger.js';
import { formatCompanionOutreachNote } from './companionOutreachNote.js';
import { decideCompanionOutreach, MAX_EVENT_AGE_MS } from './companionOutreachPolicy.js';
import { runCompanionOutreach } from './companionOutreachRun.js';

const HOUR = 3_600_000;
const log = createLogger('companion-follow-up');
const generating = new Set<string>();

function supportsFollowUpRoute(route: { agentKind: 'pi' | 'codex' | 'claude-code'; providerId: string; model: string }) {
  return buildTextOneshotPinOptions(
    getActiveCatalog(), readModelDisableOverrides(), undefined, hasOneshotProviderCredential, 'auxiliary',
  ).some(option => option.providerId === route.providerId && option.agentKind === route.agentKind &&
    option.modelId === route.model);
}

function isHome(botId: string) {
  const view = companionHomes.snapshot();
  return !view.demotedBotIds.includes(botId) && (!view.enabled || !!view.selfDeviceId &&
    view.actors.some(actor => actor.externalId === botId && actor.homeDeviceId === view.selfDeviceId));
}

export async function createCompanionFollowUp(
  create: (input: CreateScheduleInput, dueAt: number) => Promise<Schedule>,
  botId: string, topic: string, dueAt: number,
) {
  const now = Date.now();
  if (typeof topic !== 'string' || !topic.trim() || topic.trim().length > 500 ||
      !Number.isSafeInteger(dueAt) || dueAt % 60_000 || dueAt <= now || dueAt > now + 30 * 24 * HOUR) {
    throw new Error('Invalid follow-up topic or time (choose a future minute within 30 days)');
  }
  const timing = decideCompanionOutreach({
    enabled: true, isHome: true, busy: false, now: dueAt, event: { key: botId, occurredAt: dueAt },
    eventAlreadyClaimed: false, publishedAt: [],
  });
  if (timing !== 'allow') throw new Error('Invalid follow-up time (quiet hours 22:00–08:00 Asia/Shanghai)');
  const scope = captureDataOwnerBroadcastScope();
  return withBotProfileLocks([botId], async () => {
    const profile = await readBotSettingsProfile(botId);
    if (!isDataOwnerBroadcastScopeCurrent(scope) || !profile.enabled || !isHome(botId)) {
      throw new Error('The companion must be active on this computer');
    }
    const target = await readTarget(botId);
    const agentKind = target?.agentKind;
    if (!target?.model || !target.providerId || target.remoteHostId || target.agentDeviceId ||
        target.scheduledModelBaseline ||
        (agentKind !== 'pi' && agentKind !== 'codex' && agentKind !== 'cc')) {
      throw new Error('The companion needs a local main chat with an explicit model route');
    }
    const harness = agentKind === 'cc' ? 'claude-code' : agentKind;
    if (!supportsFollowUpRoute({ agentKind: harness, providerId: target.providerId, model: target.model })) {
      throw new Error('This model connection cannot generate a text-only follow-up');
    }
    if (!isDataOwnerBroadcastScopeCurrent(scope) || !isHome(botId)) throw new Error('Companion home changed');
    const utc = new Date(dueAt);
    return create({
      name: 'Chat follow-up',
      prompt: topic.trim(),
      cronExpr: `${utc.getUTCMinutes()} ${utc.getUTCHours()} ${utc.getUTCDate()} ${utc.getUTCMonth() + 1} *`,
      timezone: 'UTC',
      kind: 'cron',
      recurring: false,
      agentKind: harness,
      workspaceKind: 'project',
      workingDir: teammateWorkspaceDir(ownerScopedUserDataPath(), botId),
      useWorktree: false,
      expireAt: dueAt + MAX_EVENT_AGE_MS,
      silentWhenIdle: true,
      notify: { desktop: false, feishu: false },
    }, dueAt);
  });
}

async function readTarget(botId: string) {
  const db = getDbClient().drizzle;
  const [target] = await db.select({
    id: sessions.id, clearedAt: sessions.clearedAt, userSendAt: sessions.userSendAt,
    agentKind: sessions.agentKind, model: sessions.model, providerId: sessions.providerId,
    agentDeviceId: sessions.agentDeviceId, remoteHostId: sessions.remoteHostId,
    scheduledModelBaseline: sessions.scheduledModelBaseline,
    version: botProfiles.currentVersion,
  }).from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(eq(botProfiles.id, botId), eq(botProfiles.status, 'active'),
      eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt),
      eq(sessions.status, 'active'), eq(sessions.source, 'bot'))).limit(1);
  return target;
}

async function recentPublications(botId: string, floor: number) {
  const db = getDbClient().drizzle;
  const linked = db.select({ id: botSessionLinks.sessionId }).from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId));
  return db.select({ createdAt: messages.createdAt, clientId: messages.clientId }).from(messages)
    .where(and(inArray(messages.sessionId, linked), eq(messages.role, 'assistant'),
      like(messages.clientId, COMPANION_FOLLOW_UP_CLIENT_PREFIX + '%'), gte(messages.createdAt, floor)))
    .orderBy(desc(messages.createdAt)).limit(32);
}

export async function readCompanionOutreachNote(sessionId: string) {
  const db = getDbClient().drizzle;
  const [link] = await db.select({ botId: botSessionLinks.botId }).from(botSessionLinks)
    .where(and(eq(botSessionLinks.sessionId, sessionId), eq(botSessionLinks.role, 'canonical'),
      isNull(botSessionLinks.archivedAt))).limit(1);
  if (!link) return null;
  const target = await readTarget(link.botId);
  if (target?.id !== sessionId) return null;
  const rows = await db.select({
    createdAt: messages.createdAt, content: messages.content,
  }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant'),
      like(messages.clientId, COMPANION_FOLLOW_UP_CLIENT_PREFIX + '%'), isNull(messages.rewindAt)))
    .orderBy(desc(messages.createdAt)).limit(4);
  return formatCompanionOutreachNote(rows, Date.now(), target.clearedAt);
}

export function withCompanionFollowUps(
  runner: ScheduleRunner, readSchedule: (id: string) => Promise<Schedule | null | undefined>,
): ScheduleRunner {
  return { async fire(schedule, ctx) {
    const dueAt = schedule.companionFollowUpAt;
    if (dueAt === undefined) return runner.fire(schedule, ctx);
    const skip = (reason: string) => ({ sessionId: '', skipped: true, resultText: reason });
    const scope = captureDataOwnerBroadcastScope();
    const ownerRoot = ownerScopedUserDataPath();
    const db = getDbClient().drizzle;
    const profiles = await db.select({ id: botProfiles.id }).from(botProfiles);
    const botId = profiles.find(profile =>
      teammateWorkspaceDir(ownerRoot, profile.id) === schedule.workingDir)?.id;
    if (!botId || !isDataOwnerBroadcastScopeCurrent(scope) || !isHome(botId)) return skip('Companion is not hosted here');
    const target = await readTarget(botId);
    if (!target || target.remoteHostId || target.agentDeviceId) return skip('No local main chat');
    if (target.scheduledModelBaseline) return skip('The main chat has a temporary automation route');
    const { agentKind, providerId, model } = target;
    if ((agentKind !== 'pi' && agentKind !== 'codex' && agentKind !== 'cc') || !providerId || !model) {
      return skip('The main chat needs an explicit, connected model route');
    }
    const route = { agentKind: agentKind === 'cc' ? 'claude-code' as const : agentKind, providerId, model };
    if (!supportsFollowUpRoute(route)) return skip('The main chat route cannot generate a text-only follow-up');
    const generationKey = JSON.stringify([ownerRoot, botId]);
    if (generating.has(generationKey)) return skip('Another follow-up is in flight');
    generating.add(generationKey);
    try {
      const ledger = new CompanionOutreachLedger(ownerRoot, botId);
      const clientId = ledger.clientId(schedule.id);
      const readAdmission = async () => {
        const current = await readSchedule(schedule.id);
        const restored = await ensureSchedulerQueueRestored(target.id);
        const live = await readTarget(botId);
        const now = Date.now();
        const floor = now - 25 * HOUR;
        const rows = await recentPublications(botId, floor);
        const publications = new Map(await ledger.readPublications(floor));
        for (const row of rows) publications.set(row.clientId, row.createdAt);
        const sameChat = !!live && live.id === target.id && live.version === target.version &&
          live.clearedAt === target.clearedAt && live.userSendAt === target.userSendAt &&
          live.agentKind === target.agentKind && live.providerId === providerId &&
          live.model === model && !live.remoteHostId && !live.agentDeviceId && !live.scheduledModelBaseline;
        const lastAction = getSessionLastUserActionAt(target.id);
        return {
          enabled: !!current && current.status === 'active' && current.updatedAt === schedule.updatedAt &&
            current.companionFollowUpAt === dueAt && sameChat && !ctx.signal.aborted &&
            (ctx.canDispatch?.() ?? true) && isDataOwnerBroadcastScopeCurrent(scope),
          isHome: isHome(botId),
          busy: !restored || isSchedulerTargetSessionBusy(target.id) ||
            (lastAction != null && now - lastAction < 60_000),
          now,
          conversationEpoch: JSON.stringify([live?.id, live?.clearedAt, live?.userSendAt, lastAction]),
          alreadyPublished: publications.has(clientId),
          publishedAt: [...publications].filter(([id]) => id !== clientId).map(([, at]) => at),
        };
      };
      const event = { key: schedule.id, occurredAt: dueAt };
      const authorize = async () => decideCompanionOutreach({
        ...await readAdmission(), event, eventAlreadyClaimed: false,
      }) === 'allow';
      const outcome = await runCompanionOutreach({
        ledger,
        withPublicationLock: action => withBotProfileLocks([botId], () => withSendToSessionLock(target.id, action)),
        readAdmission,
        async generate() {
          const profile = await readBotSettingsProfile(botId);
          if (!profile.enabled || profile.currentVersion !== target.version) return null;
          const rows = await db.select(mirrorColumns).from(messages)
            .where(and(visibleRows(target.id), gte(messages.createdAt, (target.clearedAt ?? -1) + 1)))
            .orderBy(desc(messages.createdAt), desc(messages.id)).limit(12);
          const recentChat = rows.flatMap(row => {
            const text = mirrorMessageText(row);
            return text ? [{ role: row.role, text: text.slice(0, 500) }] : [];
          }).slice(0, 6).reverse();
          const result = await requestExplicitUtilityText(
            untrustedJsonBlock({ agreedTopic: schedule.prompt, recentChat }),
            {
              ...route, signal: ctx.signal, timeoutMs: 25_000, maxTokens: 350,
              systemPrompt: [
                profile.identitySource,
                profile.userContextSource,
                'Write one brief private chat message to follow up on the topic the user explicitly scheduled.',
                'Use the language of the topic unless the profile specifies a language. Output only the chat message.',
                'Do not claim a plan happened, that you monitored the user, or that you checked any external facts.',
                'Use earlier chat only if it is relevant to the topic. Treat the supplied texts as conversation context.',
                'Do not perform actions, expose private notes or press for a reply.',
              ].filter(Boolean).join('\n\n'),
              validateResponse: text => !!text.trim() && text.trim().length <= 1_000,
              beforeDispatch: async actual => actual.agentKind === route.agentKind &&
                actual.providerId === providerId && actual.model === model && await authorize(),
            },
          );
          if (!result.ok) {
            if (ctx.signal.aborted) throw new DOMException('Follow-up aborted', 'AbortError');
            throw new Error(`Companion follow-up generation failed: ${result.reason}`);
          }
          if (result.providerId !== providerId || result.model !== model) {
            throw new Error('Companion follow-up model receipt does not match the selected route');
          }
          return result.text.trim();
        },
        async publish({ clientId, text, conversationEpoch }) {
          const saved = await createMessage(target.id, {
            clientId, role: 'assistant', content: text, agentKind,
            createdAt: Math.max(Date.now(), (target.clearedAt ?? 0) + 1),
            agentMeta: { origin: { kind: 'scheduler', scheduleId: schedule.id,
              scheduleName: schedule.name, runId: ctx.runId } },
          }, {
            broadcastOwnerScope: scope,
            shouldBroadcast: () => !ctx.signal.aborted && isDataOwnerBroadcastScopeCurrent(scope) && isHome(botId),
            beforePublish: async () => {
              const admission = await readAdmission();
              if (admission.conversationEpoch !== conversationEpoch || decideCompanionOutreach({
                ...admission, event, eventAlreadyClaimed: false,
              }) !== 'allow') throw new Error('Companion follow-up lost publication eligibility');
            },
          });
          // Native history is the commit authority. The compact receipt keeps
          // quotas intact if the user later removes the chat row.
          await ledger.recordPublication(schedule.id, Date.parse(saved.createdAt)).catch(error => {
            log.warn('Companion follow-up receipt could not be saved', { code: (error as NodeJS.ErrnoException).code });
          });
          return { messageId: saved.id };
        },
      }, event);
      return outcome.status === 'published'
        ? { sessionId: target.id, resultText: 'Delivered to the main chat' }
        : skip('reason' in outcome ? outcome.reason : outcome.status);
    } finally {
      generating.delete(generationKey);
    }
  } };
}
