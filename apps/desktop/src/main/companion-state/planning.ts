import { createHash } from 'node:crypto';
import { assertId, assertTime, type PlanItem } from './types.js';
import type { StateStore } from './store.js';

export function localClock(now: number, timezone: string): { day: string; minute: number } {
  assertTime(now);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export function validatePlan(item: PlanItem, now: number): void {
  assertId(item.id); assertTime(item.expiresAt); localClock(now, item.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || new Date(`${item.date}T12:00:00Z`).toISOString().slice(0, 10) !== item.date
    || !item.title.trim() || item.title.length > 1000 || item.status !== 'pending'
    || !['activity', 'wish', 'anniversary'].includes(item.kind)
    || !['character-fiction', 'owner-commitment'].includes(item.domain)
    || item.expiresAt <= now || item.date > localClock(item.expiresAt - 1, item.timezone).day) throw new Error('COMPANION_INVALID_PLAN');
}
/** Generated life plans cannot become claims about the owner's life or shared memories. */
export async function savePlan(store: StateStore, item: PlanItem, now: number, revision: number,
  verifiedOwnerMessageId?: string): Promise<'saved' | 'duplicate'> {
  validatePlan(item, now);
  if (item.domain === 'owner-commitment' && (!verifiedOwnerMessageId || item.ownerMessageId !== verifiedOwnerMessageId))
    throw new Error('COMPANION_OWNER_EVIDENCE_REQUIRED');
  if (item.domain === 'character-fiction' && item.ownerMessageId) throw new Error('COMPANION_FICTION_HAS_OWNER_SOURCE');
  return store.update(revision, state => {
    const existing = state.plans[item.id];
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(item)) throw new Error('COMPANION_PLAN_ID_CONFLICT');
      return 'duplicate';
    }
    state.plans[item.id] = structuredClone(item);
    return 'saved';
  });
}
export async function settlePlans(store: StateStore, now: number, completeId?: string): Promise<void> {
  assertTime(now);
  await store.update(undefined, state => {
    for (const item of Object.values(state.plans)) {
      if (item.status !== 'pending') continue;
      if (item.expiresAt <= now || item.date < localClock(now, item.timezone).day) item.status = 'expired';
      else if (item.id === completeId) { item.status = 'completed'; item.completedAt = now; }
    }
  });
}
export function duePlans(items: PlanItem[], now: number): PlanItem[] {
  return items.filter(item => item.status === 'pending' && item.expiresAt > now
    && localClock(now, item.timezone).day === item.date);
}

/** Stable across scheduler ticks and process generations; one notification per dated item. */
export function planEventId(item: PlanItem): string {
  return 'plan:' + createHash('sha256').update(JSON.stringify([item.id, item.date, item.timezone])).digest('hex');
}
