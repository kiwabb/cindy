/**
 * Shared datasets (docs/shared-datasets-plan.md): a dataset that several computers of the same
 * account keep in step. One computer is the **home** (the only writer of the authoritative
 * copy); the others are **replicas** that mirror it and submit their edits to it.
 *
 * Invoke channel `maker:shared-datasets:v1` carries `caps` / `snapshot` / `submit` /
 * `handover`; the home announces writes with the push `maker:shared-datasets:changed`.
 * Only same-account computers may call the channel. An older Desktop does not list it →
 * CHANNEL_NOT_ALLOWED, and the caller treats that computer as neither home nor replica.
 *
 * Items travel as the dataset's raw stored entries (same-account computers may see internal
 * fields), so this module bounds shape and size but never interprets them. Application-level
 * outcomes (not home, out of order, dataset errors) are normal replies rather than transport
 * errors, so a caller never has to parse an error message to learn what to do next.
 */
export const SHARED_DATASETS_CHANNEL = 'maker:shared-datasets:v1';
export const SHARED_DATASETS_CHANGED_CHANNEL = 'maker:shared-datasets:changed';
export const SHARED_DATASETS_VERSION = 1;
/** A full snapshot of a large dataset can take a while to read and cross the relay. */
export const SHARED_DATASETS_TIMEOUT_MS = 45_000;
/** Serialized snapshot budget, kept well below the 2 MiB relay frame. */
export const SHARED_DATASETS_MAX_SNAPSHOT_BYTES = 1_500_000;
export const SHARED_DATASETS_MAX_UPDATE_BYTES = 256 * 1024;

export type SharedDatasetRole = 'home' | 'replica' | 'off';

export type SharedDatasetsRequest =
  | { action: 'caps' }
  | { action: 'snapshot'; dataset: string; cursor?: string }
  | {
      action: 'submit';
      dataset: string;
      /** `replica:<deviceId>`. */
      source: string;
      sequence: number;
      /** The op's stable id: a receipt only answers a retry of the same op, never a new op that reuses a sequence. */
      opId?: string;
      update: Record<string, unknown>;
    }
  | { action: 'handover'; dataset: string; newHomeDeviceId: string; homeEpoch: number };

export interface SharedDatasetCapsEntry {
  id: string;
  schemaVersion: number;
  role: SharedDatasetRole;
  homeDeviceId?: string;
  homeEpoch?: number;
}

export interface SharedDatasetsCaps {
  version: number;
  datasets: SharedDatasetCapsEntry[];
}

/** Anything the callee could not answer as home. `homeDeviceId` is a hint, never authority. */
export interface SharedDatasetsNotHome {
  notHome: true;
  homeDeviceId?: string;
  homeEpoch?: number;
}

export type SharedDatasetsSnapshotReply =
  | { cursor: string; unchanged: true }
  | { cursor: string; items: unknown[]; extras?: unknown }
  | SharedDatasetsNotHome;

export interface SharedDatasetsSubmitError {
  /** Dataset codes (ALREADY_EXISTS, CONFLICT, NOT_FOUND, INVALID_PARAMS…) or OUT_OF_ORDER / NOT_HOME. */
  code: string;
  message?: string;
  /** OUT_OF_ORDER: the sequence the home expects next from this source. */
  expectedSequence?: number;
  homeDeviceId?: string;
  homeEpoch?: number;
}

export type SharedDatasetsSubmitReply =
  | { result: unknown }
  | { error: SharedDatasetsSubmitError };

export interface SharedDatasetsHandoverReply {
  ok: true;
}

export interface SharedDatasetsChangedPush {
  dataset: string;
  cursor: string;
}

export const SHARED_DATASETS_LIMITS = {
  datasets: 64,
  idLength: 64,
  cursorLength: 200,
  deviceIdLength: 128,
  sourceLength: 160,
} as const;

const DATASET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE = /^replica:[A-Za-z0-9._:-]{1,128}$/;
const OP_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSharedDatasetId(value: unknown): value is string {
  return typeof value === 'string' && DATASET_ID.test(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** A cursor is a fingerprint; an empty dataset legitimately has an empty one. */
function cursorString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SHARED_DATASETS_LIMITS.cursorLength;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Validates the single invoke argument. Throws `SHARED_DATASETS_INVALID` on any deviation. */
export function parseSharedDatasetsRequest(value: unknown): SharedDatasetsRequest {
  if (!isRecord(value)) throw new Error('SHARED_DATASETS_INVALID');
  if (value.action === 'caps') return { action: 'caps' };
  if (!isSharedDatasetId(value.dataset)) throw new Error('SHARED_DATASETS_INVALID');
  const dataset = value.dataset;
  if (value.action === 'snapshot') {
    if (value.cursor === undefined) return { action: 'snapshot', dataset };
    if (!cursorString(value.cursor)) {
      throw new Error('SHARED_DATASETS_INVALID');
    }
    return { action: 'snapshot', dataset, cursor: value.cursor };
  }
  if (value.action === 'submit') {
    if (
      typeof value.source !== 'string' ||
      value.source.length > SHARED_DATASETS_LIMITS.sourceLength ||
      !SOURCE.test(value.source) ||
      !positiveInt(value.sequence) ||
      !isRecord(value.update) ||
      (value.opId !== undefined && (typeof value.opId !== 'string' || !OP_ID.test(value.opId))) ||
      new TextEncoder().encode(JSON.stringify(value.update)).byteLength >
        SHARED_DATASETS_MAX_UPDATE_BYTES
    ) {
      throw new Error('SHARED_DATASETS_INVALID');
    }
    return {
      action: 'submit',
      dataset,
      source: value.source,
      sequence: value.sequence,
      ...(typeof value.opId === 'string' ? { opId: value.opId } : {}),
      update: value.update,
    };
  }
  if (value.action === 'handover') {
    if (
      !boundedString(value.newHomeDeviceId, SHARED_DATASETS_LIMITS.deviceIdLength) ||
      !positiveInt(value.homeEpoch)
    ) {
      throw new Error('SHARED_DATASETS_INVALID');
    }
    return {
      action: 'handover',
      dataset,
      newHomeDeviceId: value.newHomeDeviceId,
      homeEpoch: value.homeEpoch,
    };
  }
  throw new Error('SHARED_DATASETS_INVALID');
}

/** Declared protocol version, or 0 when the reply is not a caps record. */
export function sharedDatasetsCapsVersion(value: unknown): number {
  if (!isRecord(value)) return 0;
  const version = value.version;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 0;
}

/**
 * Entries this version understands. A malformed entry is dropped instead of failing the whole
 * reply, so a newer peer that lists extra datasets or fields still yields what we know.
 */
export function parseSharedDatasetsCaps(value: unknown): SharedDatasetsCaps | null {
  const version = sharedDatasetsCapsVersion(value);
  if (!version || !isRecord(value) || !Array.isArray(value.datasets)) return null;
  const datasets: SharedDatasetCapsEntry[] = [];
  for (const raw of value.datasets.slice(0, SHARED_DATASETS_LIMITS.datasets)) {
    if (!isRecord(raw) || !isSharedDatasetId(raw.id) || !positiveInt(raw.schemaVersion)) continue;
    if (raw.role !== 'home' && raw.role !== 'replica' && raw.role !== 'off') continue;
    const entry: SharedDatasetCapsEntry = {
      id: raw.id,
      schemaVersion: raw.schemaVersion,
      role: raw.role,
    };
    if (boundedString(raw.homeDeviceId, SHARED_DATASETS_LIMITS.deviceIdLength)) {
      entry.homeDeviceId = raw.homeDeviceId;
    }
    if (positiveInt(raw.homeEpoch)) entry.homeEpoch = raw.homeEpoch;
    datasets.push(entry);
  }
  return { version, datasets };
}

export function parseSharedDatasetsChangedPush(value: unknown): SharedDatasetsChangedPush | null {
  if (!isRecord(value) || !isSharedDatasetId(value.dataset)) return null;
  if (!cursorString(value.cursor)) return null;
  return { dataset: value.dataset, cursor: value.cursor };
}

/** Reads a snapshot reply; null when it is none of the known shapes. */
export function parseSharedDatasetsSnapshotReply(value: unknown): SharedDatasetsSnapshotReply | null {
  if (!isRecord(value)) return null;
  if (value.notHome === true) {
    return {
      notHome: true,
      ...(boundedString(value.homeDeviceId, SHARED_DATASETS_LIMITS.deviceIdLength)
        ? { homeDeviceId: value.homeDeviceId }
        : {}),
      ...(positiveInt(value.homeEpoch) ? { homeEpoch: value.homeEpoch } : {}),
    };
  }
  if (!cursorString(value.cursor)) return null;
  if (value.unchanged === true) return { cursor: value.cursor, unchanged: true };
  if (!Array.isArray(value.items)) return null;
  return { cursor: value.cursor, items: value.items, extras: value.extras };
}

export function parseSharedDatasetsSubmitReply(value: unknown): SharedDatasetsSubmitReply | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.error)) {
    const error = value.error;
    if (!boundedString(error.code, 64)) return null;
    return {
      error: {
        code: error.code,
        ...(typeof error.message === 'string' ? { message: error.message.slice(0, 500) } : {}),
        ...(positiveInt(error.expectedSequence) ? { expectedSequence: error.expectedSequence } : {}),
        ...(boundedString(error.homeDeviceId, SHARED_DATASETS_LIMITS.deviceIdLength)
          ? { homeDeviceId: error.homeDeviceId }
          : {}),
        ...(positiveInt(error.homeEpoch) ? { homeEpoch: error.homeEpoch } : {}),
      },
    };
  }
  return 'result' in value ? { result: value.result } : null;
}
