import fs from 'node:fs';
import path from 'node:path';

/**
 * Closed set of personal-update failure codes that may be logged and written to `failed-<revision>.json`.
 * Underlying error messages carry paths, certificate fingerprints and tool output, so only these fixed
 * codes ever leave the failing stage.
 */
export const PERSONAL_FAILURE_CODES = [
  // macOS signing prerequisites (checked before download and again by the preparation worker).
  'PERSONAL_UPDATE_SIGNING_IDENTITY_UNAVAILABLE',
  'PERSONAL_UPDATE_REQUIRES_APPLE_DEVELOPMENT',
  'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE',
  'PERSONAL_UPDATE_HELPER_SIGNATURE',
  // Preparation worker stages.
  'PERSONAL_UPDATE_STORAGE_INCOMPATIBLE',
  'PERSONAL_UPDATE_ARCHIVE_HASH',
  'PERSONAL_UPDATE_ARCHIVE_INVALID',
  'PERSONAL_UPDATE_JOB_INVALID',
  'PERSONAL_UPDATE_EXTRACT_FAILED',
  'PERSONAL_UPDATE_SOURCE_MISMATCH',
  'PERSONAL_UPDATE_BUNDLE',
  'PERSONAL_UPDATE_ARCH',
  'PERSONAL_UPDATE_SIGNING_TIMEOUT',
  'PERSONAL_UPDATE_RESIGN_FAILED',
  'PERSONAL_UPDATE_SIGNED_SMOKE_FAILED',
  'PERSONAL_UPDATE_PACKAGE_FAILED',
  // Supervision of the worker by the main process.
  'PERSONAL_UPDATE_PREPARE_TIMEOUT',
  'PERSONAL_UPDATE_PREPARE_EXIT',
  'PERSONAL_UPDATE_PREPARED_RESULT_INVALID',
  'PERSONAL_UPDATE_WORKER_START_FAILED',
  'PERSONAL_UPDATE_JOB_CLEANUP_BLOCKED',
  // macOS transaction monitor (read back from the journal copy in `failed-<revision>.json`).
  'PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT',
  'PERSONAL_UPDATE_OLD_APP_REAPPEARED',
  'PERSONAL_UPDATE_EXIT_STATUS_UNAVAILABLE',
  'PERSONAL_UPDATE_NEW_APP_HEALTH_FAILED',
  // Generic fallbacks.
  'PERSONAL_UPDATE_PREPARATION_FAILED',
  'PERSONAL_UPDATE_APPLY_FAILED',
] as const;

export type PersonalFailureCode = typeof PERSONAL_FAILURE_CODES[number];

const KNOWN = new Set<string>(PERSONAL_FAILURE_CODES);

export function isPersonalFailureCode(value: unknown): value is PersonalFailureCode {
  return typeof value === 'string' && KNOWN.has(value);
}

/** Keeps a known code, otherwise falls back without echoing the unknown value. */
export function personalFailureCode(value: unknown, fallback: PersonalFailureCode = 'PERSONAL_UPDATE_PREPARATION_FAILED'): PersonalFailureCode {
  return isPersonalFailureCode(value) ? value : fallback;
}

/** Thrown by a named stage; its message is always a known code. */
export class PersonalStageError extends Error {
  constructor(readonly code: PersonalFailureCode) { super(code); }
}

function stageError(code: PersonalFailureCode, error: unknown): PersonalStageError {
  if (error instanceof PersonalStageError) return error;
  const message = error instanceof Error ? error.message : undefined;
  return new PersonalStageError(isPersonalFailureCode(message) ? message : code);
}

/** Runs one stage. A known code thrown inside survives; anything else becomes the stage's own code. */
export function personalStage<T>(code: PersonalFailureCode, operation: () => T): T {
  try { return operation(); } catch (error) { throw stageError(code, error); }
}

export async function personalStageAsync<T>(code: PersonalFailureCode, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw stageError(code, error); }
}

/** Signing prerequisites: the installed app cannot be updated in place until they are fixed. */
const SIGNING_CODES = new Set<PersonalFailureCode>([
  'PERSONAL_UPDATE_SIGNING_IDENTITY_UNAVAILABLE',
  'PERSONAL_UPDATE_REQUIRES_APPLE_DEVELOPMENT',
  'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE',
  'PERSONAL_UPDATE_HELPER_SIGNATURE',
]);

/** Install-step failures: preparation succeeded; the monitor rolled back and kept the current app. */
const APPLY_CODES = new Set<PersonalFailureCode>([
  'PERSONAL_UPDATE_APPLY_FAILED',
  'PERSONAL_UPDATE_EXIT_STATUS_UNAVAILABLE',
  'PERSONAL_UPDATE_NEW_APP_HEALTH_FAILED',
]);

/** The old app did not fully leave its bundle before the exchange; the verified package itself is fine. */
const EXIT_CODES = new Set<PersonalFailureCode>([
  'PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT',
  'PERSONAL_UPDATE_OLD_APP_REAPPEARED',
]);

/** `failed`: preparation; `install`: the swap step; `exit`: waiting for the old app to quit before the swap. */
export type PersonalFailureKind = 'signing' | 'failed' | 'install' | 'exit';

export function personalFailureKind(code: PersonalFailureCode): PersonalFailureKind {
  if (SIGNING_CODES.has(code)) return 'signing';
  if (EXIT_CODES.has(code)) return 'exit';
  return APPLY_CODES.has(code) ? 'install' : 'failed';
}

export interface PersonalFailureMarker {
  reason: PersonalFailureCode;
  /** macOS monitor only: the journal phase the transaction failed from (a closed set). */
  failedFromPhase?: PersonalMonitorPhase;
}

const MONITOR_PHASES = ['prepared', 'waiting-for-exit', 'swapping', 'awaiting-health'] as const;
type PersonalMonitorPhase = typeof MONITOR_PHASES[number];

/** `failureReason` values written by the transaction script; anything else stays the generic apply code. */
const MONITOR_REASONS: Record<string, PersonalFailureCode> = {
  old_bundle_exit_timeout: 'PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT',
  stale_crashpad_not_stopped: 'PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT',
  bundle_reappeared_before_swap: 'PERSONAL_UPDATE_OLD_APP_REAPPEARED',
  bundle_status_unavailable: 'PERSONAL_UPDATE_EXIT_STATUS_UNAVAILABLE',
};

function monitorFailure(value: { failureReason?: unknown; failedFromPhase?: unknown }): PersonalFailureMarker {
  const phase = MONITOR_PHASES.find(candidate => candidate === value.failedFromPhase);
  const mapped = typeof value.failureReason === 'string' && Object.hasOwn(MONITOR_REASONS, value.failureReason)
    ? MONITOR_REASONS[value.failureReason] : undefined;
  const reason = mapped ?? (phase === 'awaiting-health' ? 'PERSONAL_UPDATE_NEW_APP_HEALTH_FAILED' : 'PERSONAL_UPDATE_APPLY_FAILED');
  return phase ? { reason, failedFromPhase: phase } : { reason };
}

/**
 * Reads `failed-<revision>.json`. The file's existence alone still means "do not retry this revision";
 * the reason is best effort. Older clients wrote `{revision, phase}` or a copy of the macOS transaction
 * journal, so unknown or unreadable content maps to a generic code and never throws.
 */
export function readPersonalFailureMarker(root: string, revision: number): PersonalFailureMarker | null {
  const file = path.join(root, `failed-${revision}.json`);
  if (!fs.existsSync(file)) return null;
  let value: { reason?: unknown; phase?: unknown; failureReason?: unknown; failedFromPhase?: unknown } | null = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: generic reason */ }
  if (isPersonalFailureCode(value?.reason)) return { reason: value.reason };
  const phase = value?.phase;
  // The copied macOS journal ('failed') records the monitor's own phase and reason.
  if (phase === 'failed') return monitorFailure(value!);
  if (phase === 'windows-apply-failed') return { reason: 'PERSONAL_UPDATE_APPLY_FAILED' };
  return { reason: 'PERSONAL_UPDATE_PREPARATION_FAILED' };
}

/** Automatic attempts allowed for a revision whose only failure was the old app not quitting in time. */
export const PERSONAL_EXIT_TIMEOUT_ATTEMPTS = 2;

/**
 * An exit-wait failure happens after the package was downloaded, re-signed and smoke-tested, and the
 * monitor restored the current app before touching it. That revision gets one more automatic attempt
 * (through the normal idle or explicit install gate) instead of being skipped forever. The first marker is
 * kept as `exit-retry-<revision>-<n>.json`; a second failure of any kind stays a permanent skip.
 * Returns true when the revision was released for that retry.
 */
export function releaseRetryablePersonalFailure(root: string, revision: number): boolean {
  try {
    const failure = readPersonalFailureMarker(root, revision);
    if (!failure || personalFailureKind(failure.reason) !== 'exit') return false;
    const failed = path.join(root, `failed-${revision}.json`);
    const retries = fs.readdirSync(root).filter(name => name.startsWith(`exit-retry-${revision}-`) && name.endsWith('.json')).length;
    if (retries + 1 >= PERSONAL_EXIT_TIMEOUT_ATTEMPTS) return false;
    // Rename is atomic: the revision is either still skipped or released with its evidence kept.
    fs.renameSync(failed, path.join(root, `exit-retry-${revision}-${retries + 1}.json`));
    return true;
  } catch { return false; }
}
