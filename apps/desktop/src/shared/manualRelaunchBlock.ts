/**
 * manualRelaunchBlock.ts — why an explicit "restart to update" did not restart (personal builds).
 *
 * Only fixed categories cross the IPC boundary: no session ids, device ids, names, paths or channels.
 * Local categories reuse the restart-confirmation wording; `remote-operation` is a call another device is
 * making into this computer right now; `unknown` means activity could not be read (fail closed).
 */

import {
  joinLocalized,
  RELAUNCH_ACTIVITY_CATEGORIES,
  RELAUNCH_ACTIVITY_CATEGORY_KEYS,
  type RelaunchActivityCategory,
} from './relaunchActivitySummary.js';

export const MANUAL_RELAUNCH_BLOCK_CATEGORIES = [...RELAUNCH_ACTIVITY_CATEGORIES, 'remote-operation', 'unknown'] as const;

export type ManualRelaunchBlockCategory = RelaunchActivityCategory | 'remote-operation' | 'unknown';

export interface ManualRelaunchBlock {
  /** Monotonic per process, so the same categories reported twice still re-render. */
  id: number;
  categories: ManualRelaunchBlockCategory[];
}

const KNOWN = new Set<string>(MANUAL_RELAUNCH_BLOCK_CATEGORIES);

/** Renderer-side guard for the pushed payload. Anything unexpected becomes `unknown`, never silence. */
export function normalizeManualRelaunchBlock(value: unknown): ManualRelaunchBlock | null {
  if (value == null || typeof value !== 'object') return null;
  const { id, categories } = value as { id?: unknown; categories?: unknown };
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  const list = Array.isArray(categories) ? categories : [];
  const valid = MANUAL_RELAUNCH_BLOCK_CATEGORIES.filter(category => list.includes(category));
  const unknown = list.length === 0 || list.some(category => typeof category !== 'string' || !KNOWN.has(category));
  return { id, categories: unknown && !valid.includes('unknown') ? [...valid, 'unknown'] : valid };
}

const EXTRA_KEYS = {
  'remote-operation': 'update.banner.activity.remoteOperation',
  unknown: 'update.banner.activity.unknown',
} as const;

/** One sentence for the banner: what the refused restart would have interrupted. */
export function formatManualRelaunchBlock(
  translate: (key: string, vars?: Record<string, string>) => string,
  block: ManualRelaunchBlock,
): string {
  const categories = block.categories.length > 0 ? block.categories : (['unknown'] as const);
  const parts = categories.map(category => translate(category === 'remote-operation' || category === 'unknown'
    ? EXTRA_KEYS[category] : RELAUNCH_ACTIVITY_CATEGORY_KEYS[category]));
  const activities = joinLocalized(parts, key => translate(key), {
    joiner: 'update.banner.activityJoiner',
    pair: 'update.banner.activityJoinerPair',
    last: 'update.banner.activityJoinerLast',
  });
  return translate('update.banner.relaunchBlocked', { activities });
}
