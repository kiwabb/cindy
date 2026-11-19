import type { Session } from '@cindy/maker-core';
import { contributeCompanionContext } from './context.js';
import { createDesktopCompanionAdapters } from './desktop.js';
import { bindCompanionStateTurns } from './nativeTurns.js';
import { CompanionStateRuntime } from './runtime.js';
import { ProactiveController, effectivePolicy } from './proactive.js';
import { bindCompanionSchedule } from './scheduler.js';
import { generateFictionPlan } from './generation.js';
import { savePlan, settlePlans, duePlans, planEventId } from './planning.js';
import { assertId, assertModel, assertSameModel, type CompanionResponsesPort, type ExplicitModel, type PlanItem, type Policy, type State } from './types.js';

/** Opt-in assembly for Main. It does not create automations or import a persona. */
export function activateCompanionState(input: {
  enabled?: boolean; ownerId: string; ownerEpoch: string; botId: string; deviceId: string; session: Session; route: ExplicitModel; responses: CompanionResponsesPort;
  assertCurrent(): void; assertExecutor?(): Promise<void>; reportFailure(): void;
}) {
  if (input.enabled !== true) return null;
  assertModel(input.route);
  if (!input.responses) throw new Error('COMPANION_EXPLICIT_RESPONSES_PORT_REQUIRED');
  assertSameModel(input.route, input.responses.route);
  if (!input.deviceId) throw new Error('COMPANION_DEVICE_ID_REQUIRED');
  assertId(input.deviceId);
  const session = input.session, route = Object.freeze({ ...input.route });
  const binding = Object.freeze({ ownerId: input.ownerId, ownerEpoch: input.ownerEpoch, botId: input.botId, deviceId: input.deviceId,
    sessionId: session.id, instanceId: session.instanceId });
  let disposed = false;
  const abort = new AbortController();
  const current = () => {
    if (disposed || session.id !== binding.sessionId || session.instanceId !== binding.instanceId || session.getStatus() !== 'active' || session.remoteHostId || session.agentKind !== 'codex'
      || session.model !== route.model) throw new Error('COMPANION_BINDING_STALE');
    input.assertCurrent(); assertSameModel(route, input.responses.route);
  };
  const requireExecutor = () => {
    current();
    if (!binding.deviceId || !input.assertExecutor) throw new Error('COMPANION_EXECUTOR_REQUIRED');
  };
  const checkExecutor = async () => { requireExecutor(); await input.assertExecutor!(); current(); };
  current();
  const adapters = createDesktopCompanionAdapters(binding, { assertCurrent: current, assertExecutor: input.assertExecutor, responses: input.responses });
  const runtime = new CompanionStateRuntime({ enabled: true, binding, route, store: adapters.store,
    assertCurrent: current, verify: adapters.verify, analysis: adapters.analysis });
  const proactive = new ProactiveController(adapters.store, binding, adapters.presence, adapters.delivery, current);
  const unbind = bindCompanionStateTurns(session, { binding, assertCurrent: current,
    completed: (turn, source) => runtime.complete(turn, source.userText), reportFailure: input.reportFailure });
  const schedules = new Set<() => void>();
  let unsubscribe = () => {};
  const dispose = () => {
    if (disposed) return; disposed = true; abort.abort(); unbind(); runtime.dispose(); proactive.dispose();
    for (const stop of schedules) stop(); schedules.clear(); unsubscribe();
  };
  unsubscribe = session.onStatusChange(status => { if (status !== 'active') dispose(); });
  return {
    dispose, read: adapters.store.read,
    /** Called only by new root snapshot preparation; recovery reuses the persisted contribution. */
    prepareContribution: async (signal: AbortSignal) => {
      current(); signal.throwIfAborted();
      await adapters.assertCanonical(); current(); signal.throwIfAborted();
      const capturedAt = Date.now(), snapshot = await adapters.store.read();
      current(); signal.throwIfAborted();
      return contributeCompanionContext({ scope: binding, snapshot, capturedAt, signal, assertCurrent: current });
    },
    contributeContext: (snapshot: Readonly<State>, capturedAt: number, signal: AbortSignal, maxChars?: number) =>
      contributeCompanionContext({ scope: binding, snapshot, capturedAt, signal, maxChars, assertCurrent: current }),
    /** Explicit policy overrides only; a service activation alone does not enable proactive messages. */
    configure: async (patch: Partial<Policy>, revision: number) => {
      current();
      if (patch.enabled === true) await checkExecutor();
      return adapters.store.update(revision, state => {
        current(); const next = { ...state.policy, ...patch }; effectivePolicy(next); state.policy = next;
      });
    },
    refuse: (value: boolean) => adapters.store.update(undefined, state => {
      current(); state.refused = value;
      if (value) for (const item of Object.values(state.outbox)) if (item.status === 'pending') item.status = 'cancelled';
    }),
    /** Owner commitments are submitted only with evidence already verified by Main. */
    saveOwnerPlan: async (item: PlanItem, now: number, revision: number, verifiedOwnerMessageId: string) => {
      current();
      const snapshot = await adapters.store.read(); current();
      if (!Object.values(snapshot.turns).some(turn => turn.userMessageId === verifiedOwnerMessageId))
        throw new Error('COMPANION_OWNER_EVIDENCE_REQUIRED');
      return savePlan(adapters.store, item, now, revision, verifiedOwnerMessageId);
    },
    settlePlans: (now: number, completeId?: string) => { current(); return settlePlans(adapters.store, now, completeId); },
    generateFictionPlan: (details: { id: string; date: string; timezone: string; expiresAt: number; characterContext: string }) =>
      generateFictionPlan({ ...details, now: Date.now(), enabled: true, route, signal: abort.signal,
        store: adapters.store, assertCurrent: current, request: adapters.request }),
    enqueue: async (eventId: string, text: string, expiresAt: number) => { requireExecutor(); return proactive.enqueue(eventId, text, expiresAt); },
    enqueuePlan: async (planId: string, text: string) => {
      await checkExecutor(); const snapshot = await adapters.store.read(); current();
      const item = duePlans(Object.values(snapshot.plans), Date.now()).find(plan => plan.id === planId);
      if (!item) throw new Error('COMPANION_PLAN_NOT_DUE');
      return proactive.enqueue(planEventId(item), text, item.expiresAt, item.id);
    },
    bindSchedule: async (scheduleId: string, outboxId: string) => {
      await checkExecutor(); const stop = bindCompanionSchedule(scheduleId, { sessionId: binding.sessionId, controller: proactive, outboxId, assertCurrent: current });
      schedules.add(stop); return () => { stop(); schedules.delete(stop); };
    },
    recover: async () => { await checkExecutor(); return proactive.recover(); },
  };
}
