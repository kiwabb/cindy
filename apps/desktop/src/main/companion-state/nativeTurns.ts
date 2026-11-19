import type { SessionSendResult } from '@cindy/maker-core';
import type { Binding, CompletedTurn } from './types.js';

interface NativeSession { id: string; instanceId: string; remoteHostId: string | null }
export interface CompanionTurnSource { logicalTurnId: string; userMessageId: string; userText: string; origin: 'user' }
export interface CompanionTurnObserver {
  binding: Binding; assertCurrent(): void;
  /** Must verify durable user/assistant rows before any analysis or state mutation. */
  completed(turn: CompletedTurn, source: CompanionTurnSource): Promise<void>;
  reportFailure(): void;
}
const completions = new WeakMap<CompletedTurn, () => void>();
/** In-process evidence minted only by the trusted wrapper plus product-terminal path. */
export function assertCompanionCompletion(proof: CompletedTurn, candidate: CompletedTurn = proof): void {
  const current = completions.get(proof);
  if (!current || (Object.keys(proof) as Array<keyof CompletedTurn>).some(key => candidate[key] !== proof[key]))
    throw new Error('COMPANION_TERMINAL_PROOF_REQUIRED');
  current();
}
const bindings = new WeakMap<NativeSession, { observer: CompanionTurnObserver; turns: Map<number, CompanionTurnSource> }>();
export function bindCompanionStateTurns(session: NativeSession, observer: CompanionTurnObserver): () => void {
  observer.assertCurrent();
  if (session.remoteHostId || session.id !== observer.binding.sessionId || session.instanceId !== observer.binding.instanceId || bindings.has(session))
    throw new Error('COMPANION_SESSION_BINDING_INVALID');
  const binding = { observer: { ...observer, binding: Object.freeze({ ...observer.binding }) }, turns: new Map<number, CompanionTurnSource>() };
  bindings.set(session, binding);
  return () => { if (bindings.get(session) === binding) bindings.delete(session); binding.turns.clear(); };
}
/** Uses the existing trusted source classifier; no new channel/text-based authority inference. */
export async function withCompanionStateTurn(session: NativeSession, source: CompanionTurnSource | undefined,
  dispatch: (reserved?: (generation: number) => void) => Promise<SessionSendResult>): Promise<SessionSendResult> {
  const binding = source && bindings.get(session);
  if (!binding) return dispatch();
  const frozenSource = Object.freeze(structuredClone(source!));
  let generation: number | undefined, accepted = false;
  try {
    const result = await dispatch(value => {
      try {
        binding.observer.assertCurrent();
        if (bindings.get(session) !== binding || session.instanceId !== binding.observer.binding.instanceId
          || !Number.isSafeInteger(value) || value < 0 || generation !== undefined || binding.turns.has(value))
          throw new Error('COMPANION_RESERVATION_INVALID');
        generation = value; binding.turns.set(value, frozenSource);
      } catch {
        if (generation !== undefined) binding.turns.delete(generation);
        binding.observer.reportFailure();
      }
    });
    accepted = result.accepted; return result;
  } finally { if (!accepted && generation !== undefined) binding.turns.delete(generation); }
}
/** Only the existing product-terminal classifier calls this, never raw vendor done. */
export function finishCompanionStateTurn(session: NativeSession, generation: number,
  outcome: 'completed' | 'failed', assistantMessageId?: string): void {
  const bound = bindings.get(session), source = bound?.turns.get(generation);
  if (!bound || !source) return;
  bound.turns.delete(generation);
  if (outcome !== 'completed' || !assistantMessageId) return;
  try {
    bound.observer.assertCurrent();
    if (session.instanceId !== bound.observer.binding.instanceId) throw new Error('COMPANION_SESSION_BINDING_INVALID');
    const turn: CompletedTurn = Object.freeze({ ...bound.observer.binding, logicalTurnId: source.logicalTurnId, generation,
      userMessageId: source.userMessageId, assistantMessageId, status: 'completed', source: 'owner-private', completedAt: Date.now() });
    completions.set(turn, () => {
      if (bindings.get(session) !== bound || session.instanceId !== turn.instanceId)
        throw new Error('COMPANION_TERMINAL_PROOF_REVOKED');
      bound.observer.assertCurrent();
    });
    try {
      void bound.observer.completed(turn, source)
        .catch(() => bound.observer.reportFailure()).finally(() => completions.delete(turn));
    } catch (error) { completions.delete(turn); throw error; }
  } catch { bound.observer.reportFailure(); }
}
