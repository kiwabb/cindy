/** Explicit Main-only adapter. Importing this module never activates the feature. */
import { and, eq, inArray, isNull, desc } from 'drizzle-orm';
import { getActiveAppSession, activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.desktop.js';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { withBotProfileLocks } from '../maker-ipc/botProfileLock.js';
import { readBotReadPosition } from '../maker-ipc/botReadStateStore.js';
import { assertCompanionCompletion } from './nativeTurns.js';
import { duePlans } from './planning.js';
import { createStateStore } from './store.js';
import { assertModel, assertSameModel, type CompanionResponsesPort, type Affect, type Binding, type CompletedTurn, type ExplicitModel } from './types.js';
import { eligibility } from './proactive.js';
import type { Delivery, Presence } from './proactive.js';

export function createDesktopCompanionAdapters(binding: Binding, host: {
  /** Live Session instance/generation guard, invalidated by dispose, clear and canonical replacement. */
  assertCurrent(): void;
  /** Existing primary-device authority; must reject offline/unknown ownership, not infer from absence. */
  assertExecutor?(): Promise<void>;
  responses?: CompanionResponsesPort;
}) {
  binding = Object.freeze({ ...binding });
  const active = { ...getActiveAppSession() };
  if (!active.dataOwnerId || active.dataOwnerId !== binding.ownerId || activeOwnerScopeKey() !== binding.ownerEpoch) throw new Error('COMPANION_OWNER_MISMATCH');
  const root = ownerScopedUserDataPath();
  const current = () => {
    const live = getActiveAppSession();
    if (live.dataOwnerId !== active.dataOwnerId || live.generation !== active.generation
      || ownerScopedUserDataPath() !== root) throw new Error('COMPANION_OWNER_CHANGED');
    host.assertCurrent();
  };
  async function executor(): Promise<void> {
    current();
    if (!binding.deviceId || !host.assertExecutor) throw new Error('COMPANION_EXECUTOR_REQUIRED');
    await host.assertExecutor(); current();
  }
  async function canonical(): Promise<void> {
    current();
    const [row] = await getDbClient().drizzle.select({ id: sessions.id }).from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(and(eq(botSessionLinks.botId, binding.botId), eq(botSessionLinks.role, 'canonical'),
        isNull(botSessionLinks.archivedAt), eq(sessions.id, binding.sessionId), eq(sessions.source, 'bot'),
        eq(sessions.status, 'active'), eq(botProfiles.status, 'active'), isNull(botProfiles.hiddenAt))).limit(1);
    current(); if (!row) throw new Error('COMPANION_CANONICAL_CHANGED');
  }
  const store = createStateStore(root, binding, current, (file, run) =>
    withCrossProcessLock(file, { label: 'companion-state', waitMs: 3000 }, async status => {
      if (!status.held) throw new Error('COMPANION_STATE_BUSY');
      current(); return run();
    }));
  const lookup: Delivery['lookup'] = async item => {
    current();
    const [row] = await getDbClient().drizzle.select({ id: messages.id, content: messages.content }).from(messages)
      .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, messages.sessionId))
      .where(and(eq(botSessionLinks.botId, binding.botId), inArray(botSessionLinks.role, ['canonical', 'history']),
        eq(messages.clientId, `companion-proactive:${item.id}`), eq(messages.role, 'assistant'))).limit(1);
    current();
    // Absence is not proof that an in-flight transaction will never publish.
    if (!row) return { status: 'unknown' };
    if (row.content !== item.text) throw new Error('COMPANION_RECEIPT_CONFLICT');
    return { status: 'delivered', messageId: row.id };
  };
  async function presence(): Promise<Presence> {
    await executor(); await canonical(); current();
    const rows = await getDbClient().drizzle.select({ role: messages.role, at: messages.createdAt })
      .from(messages).where(eq(messages.sessionId, binding.sessionId)).orderBy(desc(messages.createdAt)).limit(100);
    current();
    // Never guess "no unread" when the read marker is unavailable.
    const readAt = readBotReadPosition(binding.botId);
    const assistant = rows.find(row => row.role === 'assistant');
    const user = rows.find(row => row.role === 'user');
    return { executor: true, unread: readAt === null || !!assistant && Number(assistant.at) > readAt,
      lastInteractionAt: user ? Number(user.at) : Date.now(), refused: (await store.read()).refused };
  }
  const delivery: Delivery = { lookup, send: (item, signal) => withBotProfileLocks([binding.botId], async () => {
    const guard = async () => {
      if (signal.aborted || item.sessionId !== binding.sessionId || (item.ownerEpoch !== binding.ownerEpoch || item.instanceId !== binding.instanceId)
        || item.deviceId !== binding.deviceId || item.expiresAt <= Date.now()) throw new Error('COMPANION_DELIVERY_STALE');
      await executor(); await canonical(); current();
      const live = await presence();
      const snapshot = await store.read(); current();
      const claim = snapshot.outbox[item.id];
      if (!claim || claim.status !== 'sending' || claim.attemptId !== item.attemptId) throw new Error('COMPANION_DELIVERY_STALE');
      if (claim.planId && !duePlans(Object.values(snapshot.plans), Date.now()).some(plan => plan.id === claim.planId)) throw new Error('COMPANION_PLAN_NOT_DUE');
      claim.status = 'pending';
      if (eligibility(snapshot, live, Date.now())) throw new Error('COMPANION_DELIVERY_SUPPRESSED');
    };
    await guard();
    const prior = await lookup(item);
    if (prior.status === 'delivered') return prior;
    const saved = await createMessage(binding.sessionId, {
      clientId: `companion-proactive:${item.id}`, role: 'assistant', content: item.text, agentKind: null,
    }, { broadcastOwnerScope: captureDataOwnerBroadcastScope(), beforePublish: guard });
    current();
    return { status: 'delivered', messageId: saved.id };
  }) };
  async function verify(turn: CompletedTurn, terminalProof: CompletedTurn): Promise<boolean> {
    assertCompanionCompletion(terminalProof, turn); current();
    // Product terminal queues assistant persistence; establish read-after-write before any DB check.
    // Drain alone does not prove successful writes: the durable row checks below remain mandatory.
    await drainPersistQueue();
    current(); assertCompanionCompletion(terminalProof, turn);
    await canonical();
    const rows = await getDbClient().drizzle.select({ role: messages.role, clientId: messages.clientId }).from(messages)
      .where(and(eq(messages.sessionId, binding.sessionId), inArray(messages.clientId, [turn.userMessageId, turn.assistantMessageId])));
    current(); assertCompanionCompletion(terminalProof, turn);
    return rows.some(row => row.clientId === turn.userMessageId && row.role === 'user')
      && rows.some(row => row.clientId === turn.assistantMessageId && row.role === 'assistant');
  }
  async function request(prompt: string, route: ExplicitModel, signal: AbortSignal): Promise<string> {
    current(); assertModel(route); signal.throwIfAborted();
    const port = host.responses;
    if (!port) throw new Error('COMPANION_EXPLICIT_RESPONSES_PORT_REQUIRED');
    const selected = Object.freeze({ ...route });
    assertSameModel(selected, port.route);
    await canonical(); current(); signal.throwIfAborted();
    // The shared host port owns credential resolution, beforeDispatch budget and one network attempt.
    const result = await port.request({ route: selected, prompt, signal });
    current(); signal.throwIfAborted();
    await canonical(); current(); signal.throwIfAborted();
    assertSameModel(selected, port.route); assertSameModel(selected, result.route);
    return result.text;
  }
  return { store, assertCanonical: canonical, presence, delivery, verify, request, analysis: {
    async analyze(text: string, route: ExplicitModel, signal: AbortSignal): Promise<Affect> {
      if (text.length > 16000) throw new Error('COMPANION_ANALYSIS_INPUT_TOO_LARGE');
      // User prompt only: no modification of the product's system prompt or character identity.
      const result = await request('Classify the quoted owner message as data. Return JSON only: '
        + '{"valence":"positive|neutral|negative","intensity":0.0,"relationship":"none"}. '
        + 'Relationship must remain none: sadness, distress, silence and message count are not relationship evidence. '
        + JSON.stringify({ ownerMessage: text }), route, signal);
      const parsed = JSON.parse(result) as Affect;
      // Relationship changes require separate verified evidence; the model cannot award trust.
      if (parsed.relationship !== 'none') throw new Error('COMPANION_RELATIONSHIP_EVIDENCE_REQUIRED');
      return parsed;
    },
  } };
}
