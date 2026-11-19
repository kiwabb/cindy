import { createHash, randomUUID } from 'node:crypto';
import type { StateStore } from './store.js';
import { DEFAULT_POLICY, assertId, assertTime, type Binding, type OutboxItem, type Policy, type State } from './types.js';
import { duePlans, planEventId, localClock } from './planning.js';

export interface Presence {
  /** Must be a current authoritative host decision, not an offline cached device snapshot. */
  executor: boolean; unread: boolean; lastInteractionAt: number; refused: boolean;
}
export type DeliveryReceipt = { status: 'delivered'; messageId: string }
  | { status: 'not-sent' | 'unknown' };
export interface Delivery {
  send(item: OutboxItem, signal: AbortSignal): Promise<DeliveryReceipt>;
  /** Receipt lookup only. Never send as a side effect of recovery. */
  lookup(item: OutboxItem): Promise<DeliveryReceipt>;
}
export function effectivePolicy(overrides: Partial<Policy>): Policy {
  const p = { ...DEFAULT_POLICY, ...overrides };
  localClock(0, p.timezone);
  if (typeof p.enabled !== 'boolean' || !Number.isInteger(p.quietStart) || p.quietStart < 0 || p.quietStart > 1439
    || !Number.isInteger(p.quietEnd) || p.quietEnd < 0 || p.quietEnd > 1439
    || !Number.isSafeInteger(p.dailyBudget) || p.dailyBudget < 0
    || !Number.isSafeInteger(p.cooldownMs) || p.cooldownMs < 0
    || !Number.isSafeInteger(p.recentInteractionMs) || p.recentInteractionMs < 0)
    throw new Error('COMPANION_INVALID_POLICY');
  return p;
}
export function eligibility(state: State, presence: Presence, now: number): string | null {
  assertTime(now); assertTime(presence.lastInteractionAt);
  const p = effectivePolicy(state.policy);
  if (!p.enabled) return 'disabled';
  if (!presence.executor) return 'not-executor';
  if (presence.refused || state.refused) return 'refused';
  if (presence.unread) return 'unread';
  const clock = localClock(now, p.timezone);
  const quiet = p.quietStart === p.quietEnd ? true : p.quietStart < p.quietEnd
    ? clock.minute >= p.quietStart && clock.minute < p.quietEnd
    : clock.minute >= p.quietStart || clock.minute < p.quietEnd;
  if (quiet) return 'quiet-hours';
  if (now - Math.max(presence.lastInteractionAt, state.lastInteractionAt) < p.recentInteractionMs) return 'recent-interaction';
  if (Object.values(state.outbox).some(row => row.status === 'sending' || row.status === 'unknown')) return 'unresolved-delivery';
  return null;
}
function eventKey(binding: Binding, eventId: string): string {
  return createHash('sha256').update(JSON.stringify([binding.ownerId, binding.botId, eventId])).digest('hex');
}
/** One outbox per private owner/bot. All reservations and budget increments commit together. */
export class ProactiveController {
  private readonly abort = new AbortController();
  constructor(private readonly store: StateStore, private readonly binding: Binding,
    private readonly presence: () => Promise<Presence>, private readonly delivery: Delivery,
    private readonly assertCurrent: () => void, private readonly now: () => number = Date.now) {}
  dispose(): void { this.abort.abort(); }
  private current(): void {
    if (this.abort.signal.aborted) throw new Error('COMPANION_DISPOSED');
    this.assertCurrent();
  }
  async enqueue(eventId: string, text: string, expiresAt: number, planId?: string): Promise<string> {
    this.current();
    if (!this.binding.deviceId) throw new Error('COMPANION_EXECUTOR_REQUIRED');
    const deviceId = this.binding.deviceId;
    assertId(eventId); assertTime(expiresAt);
    if (!text.trim() || text.length > 8000) throw new Error('COMPANION_INVALID_MESSAGE');
    const presence = await this.presence(); this.current();
    const now = this.now();
    if (expiresAt <= now) throw new Error('COMPANION_EVENT_EXPIRED');
    const id = eventKey(this.binding, eventId);
    return this.store.update(undefined, state => {
      this.current();
      if (planId) {
        const plan = duePlans(Object.values(state.plans), now).find(item => item.id === planId);
        if (!plan || planEventId(plan) !== eventId || plan.expiresAt !== expiresAt) throw new Error('COMPANION_PLAN_NOT_DUE');
      }
      const existing = state.outbox[id];
      if (existing) {
        if (existing.text !== text || existing.expiresAt !== expiresAt || existing.planId !== planId) throw new Error('COMPANION_EVENT_CONFLICT');
        return id;
      }
      const reason = eligibility(state, presence, now);
      if (reason) throw new Error(`COMPANION_SUPPRESSED:${reason}`);
      const p = effectivePolicy(state.policy), day = localClock(now, p.timezone).day;
      const rows = Object.values(state.outbox);
      if (rows.some(row => now - row.createdAt < p.cooldownMs)) throw new Error('COMPANION_SUPPRESSED:cooldown');
      // Rolling guard prevents a timezone edit or clock rollback from replenishing today's quota.
      if ((state.budgets[day] ?? 0) >= p.dailyBudget || rows.filter(row => now - row.createdAt < 86400_000).length >= p.dailyBudget)
        throw new Error('COMPANION_SUPPRESSED:daily-budget');
      state.budgets[day] = (state.budgets[day] ?? 0) + 1;
      state.outbox[id] = { id, eventId, ...(planId ? { planId } : {}), sessionId: this.binding.sessionId, deviceId,
        ownerEpoch: this.binding.ownerEpoch, instanceId: this.binding.instanceId, day, createdAt: now, expiresAt, text, status: 'pending' };
      return id;
    });
  }
  async dispatch(id: string): Promise<DeliveryReceipt | { status: 'suppressed' }> {
    this.current();
    const presence = await this.presence(); this.current();
    const now = this.now(), attemptId = randomUUID();
    const claimed = await this.store.update(undefined, state => {
      this.current();
      const row = state.outbox[id];
      if (!row || row.status !== 'pending') return null;
      if (row.expiresAt <= now || row.sessionId !== this.binding.sessionId || row.deviceId !== this.binding.deviceId
        || (row.ownerEpoch !== this.binding.ownerEpoch || row.instanceId !== this.binding.instanceId)) { row.status = 'cancelled'; return null; }
      if (row.planId && !duePlans(Object.values(state.plans), now).some(plan => plan.id === row.planId)) { row.status = 'cancelled'; return null; }
      if (eligibility(state, presence, now)) return null;
      row.status = 'sending'; row.attemptId = attemptId;
      return structuredClone(row);
    });
    if (!claimed) return { status: 'suppressed' };
    let receipt: DeliveryReceipt;
    try {
      // Recheck after persistence and immediately before the external boundary.
      const live = await this.presence(); this.current();
      const snapshot = await this.store.read(); this.current();
      const withoutOwnClaim = structuredClone(snapshot);
      withoutOwnClaim.outbox[id].status = 'pending';
      if (eligibility(withoutOwnClaim, live, this.now()) || claimed.expiresAt <= this.now()
        || claimed.planId && !duePlans(Object.values(snapshot.plans), this.now()).some(plan => plan.id === claimed.planId)) receipt = { status: 'not-sent' };
      else receipt = await this.delivery.send(claimed, this.abort.signal);
    } catch { receipt = { status: 'unknown' }; }
    // A disposed/changed owner must not commit a late receipt. Recovery uses lookup.
    this.current();
    await this.store.update(undefined, state => {
      this.current();
      const row = state.outbox[id];
      if (row?.status !== 'sending' || row.attemptId !== attemptId) throw new Error('COMPANION_OUTBOX_CAS_CONFLICT');
      if (receipt.status === 'delivered') {
        assertId(receipt.messageId); row.status = 'delivered'; row.receiptId = receipt.messageId; row.deliveredAt = this.now();
      } else row.status = receipt.status === 'not-sent' ? 'cancelled' : 'unknown';
    });
    return receipt;
  }
  /** Call only after obtaining the host's exclusive runtime binding; no auto resend. */
  async recover(): Promise<void> {
    this.current();
    const snapshot = await this.store.read();
    for (const row of Object.values(snapshot.outbox)) {
      this.current();
      if (row.status !== 'unknown' && row.status !== 'sending') continue;
      const receipt = await this.delivery.lookup(row); this.current();
      await this.store.update(undefined, state => {
        this.current();
        const current = state.outbox[row.id];
        if (!current || current.status !== row.status || current.attemptId !== row.attemptId) return;
        if (receipt.status === 'delivered') {
          assertId(receipt.messageId); current.status = 'delivered'; current.receiptId = receipt.messageId; current.deliveredAt = this.now();
        } else current.status = receipt.status === 'not-sent' ? 'cancelled' : 'unknown';
      });
    }
  }
}
