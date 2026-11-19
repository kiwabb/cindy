import { assertId, assertTime, type State } from './types.js';
import { effectivePolicy } from './proactive.js';
import { validatePlan } from './planning.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, low: number, high: number) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
/** Fail closed on corrupt ledgers: never replenish budgets or clear an unknown receipt. */
export function validateState(value: unknown): asserts value is State {
  const s = value as State;
  if (!record(s) || s.schema !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0
    || !record(s.affect) || !record(s.turns) || !record(s.plans) || !record(s.outbox) || !record(s.budgets)
    || !record(s.policy) || typeof s.refused !== 'boolean') throw new Error('COMPANION_STATE_INVALID');
  assertId(s.ownerId); assertId(s.botId); assertTime(s.lastInteractionAt); assertTime(s.affect.at);
  effectivePolicy(s.policy);
  if (!['positive', 'neutral', 'negative'].includes(s.affect.valence) || !finite(s.affect.intensity, 0, 1)
    || !finite(s.affect.trust, -1, 1)) throw new Error('COMPANION_STATE_INVALID');
  for (const [key, turn] of Object.entries(s.turns)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !record(turn) || !record(turn.affect)
      || !finite(turn.before, -1, 1) || !finite(turn.after, -1, 1)
      || !finite(turn.affect.intensity, 0, 1)
      || !['positive', 'neutral', 'negative'].includes(turn.affect.valence)
      || !['none', 'respect', 'repair', 'boundary-violation'].includes(turn.affect.relationship)) throw new Error('COMPANION_STATE_INVALID');
    assertTime(turn.at); assertId(turn.sessionId); assertId(turn.ownerEpoch); assertId(turn.instanceId); assertId(turn.logicalTurnId);
    if (!Number.isSafeInteger(turn.generation) || turn.generation < 0) throw new Error('COMPANION_STATE_INVALID'); assertId(turn.userMessageId); assertId(turn.assistantMessageId);
  }
  for (const [key, plan] of Object.entries(s.plans)) {
    if (!record(plan) || key !== plan.id || !['pending', 'completed', 'expired'].includes(plan.status)) throw new Error('COMPANION_STATE_INVALID');
    validatePlan({ ...plan, status: 'pending' }, 0);
    if (plan.domain === 'owner-commitment') assertId(plan.ownerMessageId!);
    if (plan.status === 'completed') assertTime(plan.completedAt!);
  }
  for (const [day, budget] of Object.entries(s.budgets)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(budget) || budget < 0) throw new Error('COMPANION_STATE_INVALID');
  }
  const reservations: Record<string, number> = {};
  for (const [key, item] of Object.entries(s.outbox)) {
    if (!record(item) || key !== item.id || !/^[a-f0-9]{64}$/.test(key)
      || !['pending', 'sending', 'delivered', 'unknown', 'cancelled'].includes(item.status)
      || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8000
      || !/^\d{4}-\d{2}-\d{2}$/.test(item.day) || !(s.budgets[item.day] > 0)) throw new Error('COMPANION_STATE_INVALID');
    reservations[item.day] = (reservations[item.day] ?? 0) + 1;
    if (item.planId !== undefined) { assertId(item.planId); if (!s.plans[item.planId]) throw new Error('COMPANION_STATE_INVALID'); }
    assertId(item.eventId); assertId(item.sessionId); assertId(item.deviceId); assertId(item.ownerEpoch); assertId(item.instanceId);
    assertTime(item.createdAt); assertTime(item.expiresAt);
    if (item.status === 'sending' || item.status === 'unknown' || item.status === 'delivered') assertId(item.attemptId!);
    if (item.status === 'delivered') { assertId(item.receiptId!); assertTime(item.deliveredAt!); }
  }
  for (const [day, count] of Object.entries(s.budgets)) {
    if (count !== (reservations[day] ?? 0)) throw new Error('COMPANION_BUDGET_CORRUPT');
  }
}
