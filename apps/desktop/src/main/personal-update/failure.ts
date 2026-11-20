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

export type PersonalFailureKind = 'signing' | 'failed';

export function personalFailureKind(code: PersonalFailureCode): PersonalFailureKind {
  return SIGNING_CODES.has(code) ? 'signing' : 'failed';
}

export interface PersonalFailureMarker { reason: PersonalFailureCode }

/**
 * Reads `failed-<revision>.json`. The file's existence alone still means "never retry this revision";
 * the reason is best effort. Older clients wrote `{revision, phase}` or a copy of the macOS transaction
 * journal, so unknown or unreadable content maps to a generic code and never throws.
 */
export function readPersonalFailureMarker(root: string, revision: number): PersonalFailureMarker | null {
  const file = path.join(root, `failed-${revision}.json`);
  if (!fs.existsSync(file)) return null;
  let value: { reason?: unknown; phase?: unknown } | null = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: generic reason */ }
  if (isPersonalFailureCode(value?.reason)) return { reason: value.reason };
  const phase = value?.phase;
  // 'windows-apply-failed' (Windows updater) and the copied macOS journal ('failed') are apply failures.
  if (phase === 'windows-apply-failed' || phase === 'failed') return { reason: 'PERSONAL_UPDATE_APPLY_FAILED' };
  return { reason: 'PERSONAL_UPDATE_PREPARATION_FAILED' };
}
