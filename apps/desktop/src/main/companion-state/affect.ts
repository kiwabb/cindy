import { createHash } from 'node:crypto';
import { assertId, assertTime, type Affect, type Binding, type CompletedTurn, type State } from './types.js';
import type { StateStore } from './store.js';

export function turnKey(turn: CompletedTurn): string {
  return createHash('sha256').update(JSON.stringify(['companion-turn-v1', turn.ownerId, turn.botId, turn.logicalTurnId])).digest('hex');
}
export function assertTurn(turn: CompletedTurn, binding: Binding): void {
  for (const key of ['ownerId', 'ownerEpoch', 'botId', 'sessionId', 'instanceId', 'deviceId'] as const) {
    assertId(turn[key]);
    if (turn[key] !== binding[key]) throw new Error('COMPANION_STALE_TURN');
  }
  assertId(turn.logicalTurnId);
  if (!Number.isSafeInteger(turn.generation) || turn.generation < 0) throw new Error('COMPANION_INVALID_TURN_GENERATION'); assertId(turn.userMessageId); assertId(turn.assistantMessageId);
  assertTime(turn.completedAt);
  if (turn.status !== 'completed' || turn.source !== 'owner-private') throw new Error('COMPANION_UNTRUSTED_TURN');
}
/** Intensity fades with elapsed time; trust is never penalized for silence or sadness. */
export function affectAt(state: State, now: number): State['affect'] {
  assertTime(now);
  return { ...state.affect, intensity: state.affect.intensity * 2 ** (-Math.max(0, now - state.affect.at) / 86400_000) };
}
export async function applyAffect(store: StateStore, binding: Binding, turn: CompletedTurn,
  affect: Affect, expectedRevision: number, assertCurrent: () => void): Promise<'applied' | 'duplicate' | 'outdated'> {
  assertCurrent(); assertTurn(turn, binding);
  if (!['positive', 'neutral', 'negative'].includes(affect.valence)
    || !Number.isFinite(affect.intensity) || affect.intensity < 0 || affect.intensity > 1
    || !['none', 'respect', 'repair', 'boundary-violation'].includes(affect.relationship))
    throw new Error('COMPANION_INVALID_AFFECT');
  return store.update(expectedRevision, state => {
    assertCurrent();
    const key = turnKey(turn);
    if (state.turns[key]) {
      if (state.turns[key].userMessageId !== turn.userMessageId) throw new Error('COMPANION_LOGICAL_TURN_CONFLICT');
      return 'duplicate';
    }
    // Preserve late analysis as an auditable no-op, never replace a newer emotional state.
    const outdated = turn.completedAt < state.affect.at;
    const before = state.affect.trust;
    const delta = affect.relationship === 'none' ? 0 : affect.relationship === 'boundary-violation' ? -0.02 : 0.01;
    const after = outdated ? before : Math.max(-1, Math.min(1, before + delta));
    state.turns[key] = { at: turn.completedAt, sessionId: turn.sessionId, ownerEpoch: turn.ownerEpoch, instanceId: turn.instanceId, generation: turn.generation, logicalTurnId: turn.logicalTurnId, userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId, before, after, affect };
    if (!outdated) state.affect = { valence: affect.valence, intensity: affect.intensity, at: turn.completedAt, trust: after };
    state.lastInteractionAt = Math.max(state.lastInteractionAt, turn.completedAt);
    return outdated ? 'outdated' : 'applied';
  });
}
