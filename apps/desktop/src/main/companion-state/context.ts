import { affectAt } from './affect.js';
import { duePlans } from './planning.js';
import { assertTime, type Scope, type State } from './types.js';
import { validateState } from './validation.js';

export interface CompanionContextContribution {
  readonly revision: number;
  readonly text: string;
  readonly sourceRefs: readonly string[];
}
/**
 * Pure projection of a host-frozen snapshot. No IO, clock reads, model calls or mutations.
 * Main captures once inside root MemoryTurnContext.prepare; recovery reuses the persisted result.
 * Only data is returned, never personality, relationship escalation or user-facing instructions.
 */
export function contributeCompanionContext(input: {
  scope: Scope; snapshot: Readonly<State>; capturedAt: number; maxChars?: number;
  assertCurrent(): void; signal: AbortSignal;
}): CompanionContextContribution {
  const current = () => { input.signal.throwIfAborted(); input.assertCurrent(); };
  current(); assertTime(input.capturedAt); validateState(input.snapshot);
  if (input.snapshot.ownerId !== input.scope.ownerId || input.snapshot.botId !== input.scope.botId)
    throw new Error('COMPANION_CONTEXT_SCOPE_MISMATCH');
  const limit = input.maxChars ?? 2000;
  if (!Number.isInteger(limit) || limit < 0 || limit > 4096) throw new Error('COMPANION_CONTEXT_LIMIT_INVALID');
  const snapshot = input.snapshot;
  const data: { kind: 'companion-state-data'; affect?: { valence: string; intensity: number; trust: number };
    plans: Array<{ id: string; domain: string; kind: string; title: string; date: string; timezone: string }> } = {
      kind: 'companion-state-data', plans: [],
    };
  const refs: string[] = [];
  let text = '';
  const latest = Object.entries(snapshot.turns).filter(([, turn]) => turn.at === snapshot.affect.at)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)[0];
  if (latest) {
    const affect = affectAt(snapshot as State, input.capturedAt);
    data.affect = { valence: affect.valence, intensity: affect.intensity, trust: affect.trust };
    const candidate = JSON.stringify(data);
    if (candidate.length <= limit) { text = candidate; refs.push(`turn:${latest[0]}`); }
    else delete data.affect;
  }
  const plans = duePlans(Object.values(snapshot.plans), input.capturedAt)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const plan of plans) {
    current();
    if (refs.length >= 32) break;
    const entry = { id: plan.id, domain: plan.domain, kind: plan.kind, title: plan.title, date: plan.date, timezone: plan.timezone };
    data.plans.push(entry);
    const candidate = JSON.stringify(data);
    if (candidate.length > limit) { data.plans.pop(); continue; }
    text = candidate; refs.push(`plan:${plan.id}`);
  }
  current();
  return Object.freeze({ revision: snapshot.revision, text, sourceRefs: Object.freeze(refs) });
}
