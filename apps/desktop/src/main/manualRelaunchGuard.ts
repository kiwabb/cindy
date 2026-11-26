/**
 * manualRelaunchGuard.ts — the guard for an explicit, user-clicked "restart to update" on personal builds.
 *
 * The unattended update probe (`setUpdateAutoRelaunchBusyProbe`) also yields to *passive* remote activity:
 * another device viewing a session, the legacy `*` topic, a live file-tree watch, or an attached Remote
 * Agent long-poll. That is right for an update nobody asked for. Reused for a click, it made "restart"
 * silently do nothing whenever another device happened to be looking at this one.
 *
 * A click is refused only for work the restart would actually cut off:
 *   - local activity (the same sources and fail-closed rules as the restart confirmation:
 *     relaunchBusyActivity.ts);
 *   - a remote call operating on this computer right now (not long-polls).
 * Passive viewing does not refuse a click. Any read failure refuses it (fail closed), and the caller
 * reports the refusal on screen instead of returning silently.
 */

import { summarizeRelaunchActivity, type RelaunchTurnFacts } from '../shared/relaunchActivitySummary.js';
import type { ManualRelaunchBlockCategory } from '../shared/manualRelaunchBlock.js';
import type { RelaunchBusyActivity } from './relaunchBusyActivity.js';

export interface ManualRelaunchGuardDeps {
  /** Local restart-sensitive activity (relaunchBusyActivity.evaluateRelaunchBusyActivity). */
  readLocalActivity: () => Promise<RelaunchBusyActivity>;
  /** Visible companion / conversation facts for `session-in-turn`; null when unavailable. */
  describeTurns: () => Promise<RelaunchTurnFacts | null>;
  /** A remote call other than a Remote Agent long-poll is executing on this computer. */
  hasInFlightRemoteOperations: () => boolean;
}

export interface ManualRelaunchGuardResult {
  blocked: boolean;
  /** Fixed labels for the log only. */
  reasons: string[];
  /** Fixed categories for the screen. */
  categories: ManualRelaunchBlockCategory[];
}

const NOT_WIRED: ManualRelaunchGuardResult = { blocked: true, reasons: ['manual-guard-not-ready'], categories: ['unknown'] };

export function manualRelaunchGuardNotReady(): ManualRelaunchGuardResult {
  return { ...NOT_WIRED, reasons: [...NOT_WIRED.reasons], categories: [...NOT_WIRED.categories] };
}

function readRemote(deps: ManualRelaunchGuardDeps): 'busy' | 'idle' | 'failed' {
  try { return deps.hasInFlightRemoteOperations() ? 'busy' : 'idle'; } catch { return 'failed'; }
}

export async function evaluateManualRelaunchGuard(deps: ManualRelaunchGuardDeps): Promise<ManualRelaunchGuardResult> {
  const reasons: string[] = [];
  const categories = new Set<ManualRelaunchBlockCategory>();
  const noteRemote = (state: 'busy' | 'idle' | 'failed') => {
    if (state === 'busy' && !reasons.includes('remote-operation-in-flight')) {
      reasons.push('remote-operation-in-flight');
      categories.add('remote-operation');
    }
    if (state === 'failed' && !reasons.includes('remote-operation-probe-failed')) {
      reasons.push('remote-operation-probe-failed');
      categories.add('unknown');
    }
  };

  noteRemote(readRemote(deps));

  let local: RelaunchBusyActivity;
  try { local = await deps.readLocalActivity(); }
  catch { local = { busy: true, reasons: ['local-activity-probe-failed'] }; }
  if (local.busy) {
    reasons.push(...local.reasons);
    let turns: RelaunchTurnFacts | null = null;
    if (local.reasons.includes('session-in-turn')) {
      try { turns = await deps.describeTurns(); } catch { turns = null; }
    }
    const summary = summarizeRelaunchActivity(local.reasons, turns);
    if (summary.categories.length === 0) categories.add('unknown');
    for (const category of summary.categories) categories.add(category);
  }

  // Re-sample after the async reads: a remote call can start while SQLite is being queried.
  noteRemote(readRemote(deps));

  const ordered = (['companion', 'conversation', 'background-command', 'scheduled-task', 'generation', 'subtask',
    'remote-operation', 'unknown'] as const).filter(category => categories.has(category));
  return { blocked: reasons.length > 0, reasons, categories: ordered };
}
