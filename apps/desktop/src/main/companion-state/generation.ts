import { assertModel, type ExplicitModel, type PlanItem } from './types.js';
import { validatePlan, savePlan } from './planning.js';
import type { StateStore } from './store.js';

/** Uses the same explicitly pinned request port as affect analysis; no auxiliary defaults. */
export async function generateFictionPlan(input: {
  enabled?: boolean; route: ExplicitModel; characterContext: string;
  date: string; timezone: string; expiresAt: number; id: string; now: number; signal: AbortSignal;
  store: StateStore; assertCurrent(): void;
  request(prompt: string, route: ExplicitModel, signal: AbortSignal): Promise<string>;
}): Promise<PlanItem | null> {
  if (input.enabled !== true) return null;
  input.assertCurrent(); assertModel(input.route);
  if (input.signal.aborted) throw new Error('COMPANION_DISPOSED');
  if (input.characterContext.length > 12000) throw new Error('COMPANION_CHARACTER_CONTEXT_TOO_LARGE');
  const before = await input.store.read(); input.assertCurrent();
  // Caller chooses date/id/expiry; model cannot create real appointments or shared memories.
  const draft: PlanItem = { id: input.id, date: input.date, timezone: input.timezone, expiresAt: input.expiresAt,
    kind: 'activity', domain: 'character-fiction', title: 'pending generation', status: 'pending' };
  validatePlan(draft, input.now);
  const existing = before.plans[draft.id];
  if (existing) {
    if (existing.domain !== 'character-fiction' || existing.date !== draft.date || existing.timezone !== draft.timezone
      || existing.expiresAt !== draft.expiresAt) throw new Error('COMPANION_PLAN_ID_CONFLICT');
    return existing;
  }
  const raw = await input.request('Return JSON {"title":"one fictional character activity"}. '
    + 'Use only the supplied character context. This is fiction, not a real owner commitment or a shared past experience. '
    + 'Do not ask for attention, imply exclusivity or dependence, or invent an owner biography. '
    + JSON.stringify({ characterContext: input.characterContext, date: input.date, timezone: input.timezone }), input.route, input.signal);
  input.assertCurrent();
  if (input.signal.aborted) throw new Error('COMPANION_DISPOSED');
  const parsed = JSON.parse(raw) as { title: string };
  const item = { ...draft, title: parsed.title };
  validatePlan(item, input.now);
  await savePlan(input.store, item, input.now, before.revision);
  return item;
}
