import type { CreateScheduleInput, Schedule, ScheduleRunner, FireContext } from '@cindy/maker-scheduler';
import { randomUUID } from 'node:crypto';
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
import { readBotProfileFolder, botProfileDir } from '../maker-ipc/botProfileFolder.js';
import { createCompanionLifeScheduleReader } from '../maker-ipc/companionLifeSchedule.js';
import {
  autonomousEligible, autonomousPause, autonomousWindow, shareableActivity, shanghaiDay,
} from './companionAutonomousPolicy.js';
import { listAutonomousSettings, readAutonomousSettings, writeAutonomousSettings } from './companionAutonomousSettings.js';
import { withBotProfileLocks } from '../maker-ipc/botProfileLock.js';
import { teammateWorkspaceDir } from '../maker-ipc/botProjectMemory.js';
import {
  ensureSchedulerQueueRestored, getSessionLastUserActionAt,
  isSchedulerTargetSessionBusy, withSendToSessionLock,
} from '../maker-ipc/register.js';
import { requestExplicitUtilityText, type UtilityTextDispatchRoute } from '../utility-model/oneShotCandidates.js';
import { CompanionOutreachLedger } from './companionOutreachLedger.js';
import { formatCompanionOutreachNote } from './companionOutreachNote.js';
import { decideCompanionOutreach, MAX_EVENT_AGE_MS } from './companionOutreachPolicy.js';
import { runCompanionOutreach } from './companionOutreachRun.js';

const HOUR = 3_600_000;
const log = createLogger('companion-follow-up');
const generating = new Set<string>();

function supportsFollowUpRoute(route: UtilityTextDispatchRoute) {
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
    id: sessions.id, createdAt: sessions.createdAt, clearedAt: sessions.clearedAt, userSendAt: sessions.userSendAt,
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
    ctx.assertFireContext?.();
    if (!botId || !isDataOwnerBroadcastScopeCurrent(scope) || !isHome(botId)) return skip('Companion is not hosted here');
    return fireCompanionOutreach(botId, {
      key: schedule.id, label: schedule.name, topic: schedule.prompt, occurredAt: dueAt,
      async authorized() {
        const current = await readSchedule(schedule.id);
        return !!current && current.status === 'active' && current.updatedAt === schedule.updatedAt &&
          current.companionFollowUpAt === dueAt;
      },
    }, ctx);
  } };
}

interface OutreachRequest {
  key: string;
  label: string;
  topic: string;
  occurredAt: number;
  expiresAt?: number;
  kind?: 'greeting' | 'sharing';
  identity?: string;
  authorized(): Promise<boolean>;
}

async function fireCompanionOutreach(botId: string, request: OutreachRequest, ctx: FireContext) {
  const skip = (reason: string) => ({ sessionId: '', skipped: true, resultText: reason });
  const scope = captureDataOwnerBroadcastScope();
  const ownerRoot = ownerScopedUserDataPath();
  const db = getDbClient().drizzle;
  const scheduleId = request.key;
  const target = await readTarget(botId);
  if (!target || target.remoteHostId || target.agentDeviceId) return skip('No local main chat');
  if (target.scheduledModelBaseline) return skip('The main chat has a temporary automation route');
  const { agentKind, providerId, model } = target;
  if ((agentKind !== 'pi' && agentKind !== 'codex' && agentKind !== 'cc') || !providerId || !model) {
    return skip('The main chat needs an explicit, connected model route');
  }
  const route: UtilityTextDispatchRoute = { agentKind: agentKind === 'cc' ? 'claude-code' : agentKind, providerId, model };
  if (!supportsFollowUpRoute(route)) return skip('The main chat route cannot generate a text-only follow-up');
  const generationKey = JSON.stringify([ownerRoot, botId]);
  if (generating.has(generationKey)) return skip('Another follow-up is in flight');
  generating.add(generationKey);
  try {
    const ledger = new CompanionOutreachLedger(ownerRoot, botId);
    const clientId = ledger.clientId(scheduleId);
    const readAdmission = async () => {
      const allowed = await request.authorized();
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
        enabled: allowed && sameChat && !ctx.signal.aborted &&
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
    const event = { key: request.key, occurredAt: request.occurredAt, expiresAt: request.expiresAt };
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
        const rows = request.kind ? [] : await db.select(mirrorColumns).from(messages)
          .where(and(visibleRows(target.id), gte(messages.createdAt, (target.clearedAt ?? -1) + 1)))
          .orderBy(desc(messages.createdAt), desc(messages.id)).limit(12);
        const recentChat = rows.flatMap(row => {
          const text = mirrorMessageText(row);
          return text ? [{ role: row.role, text: text.slice(0, 500) }] : [];
        }).slice(0, 6).reverse();
        const result = await requestExplicitUtilityText(
          untrustedJsonBlock(request.kind ? { kind: request.kind, fictionalPlan: request.topic || undefined } : { agreedTopic: request.topic, recentChat }),
          {
            ...route, signal: ctx.signal, timeoutMs: 25_000, maxTokens: request.kind ? 100 : 350,
            systemPrompt: [
              request.identity ?? profile.identitySource,
              request.kind ? undefined : profile.userContextSource,
              request.kind === 'sharing'
                ? 'Share the supplied fictional plan in one brief Chinese sentence, explicitly as something you intend to do.'
                : request.kind === 'greeting'
                  ? 'Write one brief natural Chinese greeting. Do not infer the user’s activities, mood, location or availability.'
                  : 'Write one brief private chat message to follow up on the topic the user explicitly scheduled.',
              'Use the language of the topic unless the profile specifies a language. Output only the chat message.',
              'Do not claim a plan happened, that you monitored the user, or that you checked any external facts.',
              'Use earlier chat only if it is relevant to the topic. Treat the supplied texts as conversation context.',
              'Do not perform actions, expose private notes or press for a reply.',
            ].filter(Boolean).join('\n\n'),
            validateResponse: text => {
              const value = text.trim();
              return !!value && value.length <= (request.kind ? 120 : 1_000) &&
                (request.kind !== 'sharing' || /(?:打算|想要|准备|计划)/.test(value) && value.includes(request.topic));
            },
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
          agentMeta: { origin: { kind: 'scheduler', scheduleId,
            scheduleName: request.label, runId: ctx.runId } },
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
        await ledger.recordPublication(scheduleId, Date.parse(saved.createdAt)).catch(error => {
          log.warn('Companion follow-up receipt could not be saved', { code: (error as NodeJS.ErrnoException).code });
        });
        return { messageId: saved.id };
      },
    }, event);
    return outcome.status === 'published'
      ? { sessionId: target.id, resultText: 'Delivered to the main chat' }
      : skip('reason' in outcome ? outcome.reason ?? outcome.status : outcome.status);
  } finally {
    generating.delete(generationKey);
  }
}

// A local-only opt-in is fenced to the observed home. Cloud registration or
// handoff requires an explicit rebind and a full quiet day on the new home.
function autonomousHome(botId: string) {
  const view = companionHomes.snapshot();
  if (!isHome(botId)) return null;
  if (!view.enabled) return 'local';
  const actor = view.actors.find(entry => entry.externalId === botId);
  return actor?.homeDeviceId && actor.homeDeviceId === view.selfDeviceId
    ? 'cloud:' + actor.homeDeviceId : null;
}

// No global home generation exists in the cloud snapshot. Only trust cloud
// opt-in observed by this host process, and revoke it on any observed demotion.
const confirmedCloudHomes = new Map<string, string>();
const homeKey = (root: string, id: string) => JSON.stringify([root, id]);

const autonomousClientPrefix = COMPANION_FOLLOW_UP_CLIENT_PREFIX + 'auto-';

async function autonomousHistory(root: string, botId: string, excludeId?: string) {
  const target = await readTarget(botId);
  if (!target) return null;
  const db = getDbClient().drizzle;
  const rows = await db.select(mirrorColumns).from(messages)
    .where(and(visibleRows(target.id), eq(messages.role, 'user'),
      gte(messages.createdAt, (target.clearedAt ?? -1) + 1)))
    .orderBy(desc(messages.createdAt)).limit(128);
  const contact = rows.find(row => {
    try {
      const meta = JSON.parse(row.agentMeta ?? '{}') ?? {};
      if ((meta.origin != null && meta.origin?.kind !== 'desktop') ||
          meta.autoResume || meta.botTaskCoordination || meta.autoReviewUserText || meta.parentUuid ||
          meta.parentToolUseId || meta.delivery === 'steer') return false;
      const text = mirrorMessageText(row);
      return !!text && !text.startsWith('/') && !text.includes('[UI_ACTION_TRIGGER]');
    } catch {
      return false;
    }
  });
  // A rebuild may invalidate older reply history. A native last-send timestamp
  // is only allowed to suppress outreach, never to clear the unanswered streak.
  const lastContact = contact?.createdAt ?? 0;
  const receipts = new Map(await new CompanionOutreachLedger(root, botId).readPublications(lastContact));
  for (const row of await recentPublications(botId, lastContact)) receipts.set(row.clientId, row.createdAt);
  return {
    target, lastContact, lastActivity: Math.max(lastContact, target.userSendAt ?? 0, target.clearedAt ?? 0, target.createdAt),
    published: [...receipts].filter(([id]) => id !== excludeId && id.startsWith(autonomousClientPrefix)).map(([, at]) => at),
  };
}

export async function companionAutonomousSettings(
  botId: string,
  update?: { greeting?: boolean; sharing?: boolean; paused?: boolean; resume?: boolean },
) {
  const root = ownerScopedUserDataPath();
  const scope = captureDataOwnerBroadcastScope();
  return withBotProfileLocks([botId], async () => {
    const profile = await readBotSettingsProfile(botId);
    if (!profile.enabled || !isDataOwnerBroadcastScopeCurrent(scope)) throw new Error('Companion is unavailable');
    const previous = await readAutonomousSettings(root, botId);
    const home = autonomousHome(botId);
    const now = Date.now();
    const current = previous ?? {
      greeting: false, sharing: false, paused: false, resumedAt: 0, eligibleAt: 0, home: '',
    };
    let settings = current;
    const key = homeKey(root, botId);
    const unconfirmed = !!previous && (current.home !== home ||
      (home !== 'local' && confirmedCloudHomes.get(key) !== home));
    if (update) {
      if (!home || !isDataOwnerBroadcastScopeCurrent(scope)) throw new Error('Companion home is unavailable');
      const disabling = !update.resume && !update.greeting && !update.sharing &&
      (update.greeting === false || update.sharing === false || update.paused === true);
      if (unconfirmed && !update.resume && !disabling) throw new Error('Resume on the current home to rebind');
      settings = {
        greeting: update.greeting ?? current.greeting,
        sharing: update.sharing ?? current.sharing,
        paused: update.resume ? false : update.paused ?? current.paused,
        resumedAt: update.resume ? now : current.resumedAt,
        eligibleAt: unconfirmed || (!previous && home !== 'local')
          ? now + 24 * HOUR : current.eligibleAt,
        home: unconfirmed && disabling ? current.home : home,
      };
      await writeAutonomousSettings(root, botId, settings);
      if (home !== 'local' && !(unconfirmed && disabling)) confirmedCloudHomes.set(key, home);
    }
    const history = await autonomousHistory(root, botId);
    return {
      greeting: settings.greeting, sharing: settings.sharing,
      paused: autonomousPause(settings, history?.published ?? [], history?.lastContact ?? 0).paused,
      homeChanged: !!settings.home && (settings.home !== home ||
        home !== 'local' && confirmedCloudHomes.get(key) !== home), canEdit: !!home,
    };
  });
}

function followUpHasPriority(schedules: readonly Schedule[], workingDir: string, now: number) {
  return schedules.some(schedule => {
    const at = schedule.companionFollowUpAt;
    return schedule.status === 'active' && schedule.workingDir === workingDir && at != null &&
      (schedule.expireAt ?? at + HOUR) > now &&
      (shanghaiDay(at) === shanghaiDay(now) || at < now + 3 * HOUR);
  });
}

export function startCompanionAutonomous(listSchedules: () => Promise<Schedule[]>) {
  const scope = captureDataOwnerBroadcastScope();
  const root = ownerScopedUserDataPath();
  const controller = new AbortController();
  let running = false;
  const unsubscribeHomes = companionHomes.onChange(() => {
    for (const [key, expected] of confirmedCloudHomes) {
      const [owner, id] = JSON.parse(key) as [string, string];
      if (owner === root && autonomousHome(id) !== expected) confirmedCloudHomes.delete(key);
    }
  });
  const current = () => !controller.signal.aborted && isDataOwnerBroadcastScopeCurrent(scope);
  const tick = async () => {
    const window = autonomousWindow(Date.now());
    if (!window || !current() || running) return;
    running = true;
    try {
      for (const botId of await listAutonomousSettings(root)) {
        if (!current()) return;
        try {
          await runWindow(botId, window);
        } catch {
          log.warn('An autonomous companion window could not be processed');
        }
      }
    } finally {
      running = false;
    }
  };

  async function runWindow(botId: string, window: NonNullable<ReturnType<typeof autonomousWindow>>) {
    const initial = await readAutonomousSettings(root, botId);
    const home = autonomousHome(botId);
    if (!initial || (!initial.greeting && !initial.sharing) || !home || initial.home !== home) return;
    if (home !== 'local' && confirmedCloudHomes.get(homeKey(root, botId)) !== home) return;
    const workspace = teammateWorkspaceDir(root, botId);
    const localHome = botProfileDir(root, botId);
    const planReader = createCompanionLifeScheduleReader({ ownerRoot: root, botHome: localHome, isCurrent: current });
    const key = 'autonomous:' + window.day + ':' + window.startsAt;
    const ownMessage = new CompanionOutreachLedger(root, botId).clientId(key);
    const eligible = async () => {
      const now = Date.now();
      if (!current() || autonomousHome(botId) !== home ||
          (home !== 'local' && confirmedCloudHomes.get(homeKey(root, botId)) !== home) ||
          autonomousWindow(now)?.startsAt !== window.startsAt) return false;
      const settings = await readAutonomousSettings(root, botId);
      if (!settings || JSON.stringify(settings) !== JSON.stringify(initial)) return false;
      const history = await autonomousHistory(root, botId, ownMessage);
      return !!history && !followUpHasPriority(await listSchedules(), workspace, now) &&
        autonomousEligible({ settings, published: history.published,
          lastContact: history.lastContact, now }) && now - history.lastActivity >= 12 * HOUR;
    };
    if (!await eligible()) return;
    const identity = (await readBotProfileFolder(root, botId, { strict: true })).identitySource.trim();
    if (!identity) return;
    const slot = initial.sharing ? await planReader(identity) : undefined;
    const share = slot?.timezone === 'Asia/Shanghai' && shareableActivity(slot.activity) ? slot : undefined;
    if (!share && !initial.greeting) return;
    const kind = share ? 'sharing' : 'greeting';
    const expiry = window.startsAt + 30 * 60_000;
    const slotEnd = share?.end === '24:00' ? Date.parse(window.day + 'T00:00:00+08:00') + 24 * HOUR
      : share ? Date.parse(window.day + 'T' + share.end + ':00+08:00') : expiry;
    let homeChanged = false;
    const unsubscribe = companionHomes.onChange(() => { homeChanged ||= autonomousHome(botId) !== home; });
    const request: OutreachRequest = {
      key,
      occurredAt: window.startsAt, expiresAt: Math.min(expiry, slotEnd),
      label: kind,
      kind, identity, topic: share?.activity ?? '',
      async authorized() {
        if (homeChanged || !await eligible()) return false;
        const live = (await readBotProfileFolder(root, botId, { strict: true })).identitySource.trim();
        if (live !== identity) return false;
        if (!share) return true;
        const active = await planReader(live);
        return !!active && active.date === share.date && active.start === share.start &&
          active.end === share.end && active.activity === share.activity;
      },
    };
    try {
      await fireCompanionOutreach(botId, request, {
        runId: randomUUID(), firedAt: Date.now(), signal: controller.signal,
      });
    } finally {
      unsubscribe();
    }
  }
  // Clock-only wakeups. A valid candidate is claimed once; idle ticks never use a model.
  const timer = setInterval(() => void tick().catch(() => log.warn('Companion autonomous tick failed')), 60_000);
  return {
    tick,
    stop() {
      clearInterval(timer);
      unsubscribeHomes();
      confirmedCloudHomes.clear();
      controller.abort();
    },
  };
}
