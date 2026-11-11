import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SharedDatasetRole } from '@cindy/device-link';
import type { SharedDatasetConflict, SharedUpdate } from './types.js';

export interface DatasetState {
  role: SharedDatasetRole;
  homeDeviceId?: string;
  homeEpoch: number;
  /** Replica: the home's cursor the mirror was last made equal to. */
  cursor?: string;
  extras?: unknown;
  lastSyncedAt?: number;
}

export interface OutboxOp {
  sequence: number;
  update: SharedUpdate;
  createdAt: number;
  /**
   * Op identity: stable across sequence rebasing; names the op to the home (receipt matching),
   * to a writer waiting for its flush, and to the conflict it may become.
   */
  opId: string;
  /** Creations: the id of the optimistic placeholder in the mirror. */
  localId?: string;
}

export interface Outbox {
  /**
   * Next wire sequence for new ops. Role changes never reset it; it moves backwards only when a
   * home with fresh receipts dictates it (rebase). Op identity is `opId`, never the sequence.
   */
  nextSequence: number;
  ops: OutboxOp[];
  /** Placeholder id → id the home assigned; kept while a queued op still names the placeholder. */
  idMap: Record<string, string>;
  /**
   * Home item id → the home revision our queued edits for it are based on: the revision the item
   * had when the first edit was queued, then the revision our last accepted op produced. Every
   * submitted edit carries it, never the optimistic revision shown in the mirror.
   */
  bases: Record<string, number>;
}

export interface Receipt {
  sequence: number;
  /** Detects a reused sequence carrying a different update. */
  hash: string;
  result?: unknown;
  error?: { code: string; message?: string };
}

export type Receipts = Record<string, Receipt>;

export const EMPTY_STATE: DatasetState = { role: 'off', homeEpoch: 0 };
export const EMPTY_OUTBOX: Outbox = { nextSequence: 1, ops: [], idMap: {}, bases: {} };

export class SharedDatasetCorruptError extends Error {
  constructor(file: string) {
    super(`SHARED_DATASET_CORRUPT: ${path.basename(file)}`);
  }
}

/**
 * The four per-dataset files under `<owner>/shared-datasets/<id>/`. A damaged file fails loudly:
 * silently starting over would drop queued user edits or forget a role.
 */
export function createDatasetFiles(dir: string, assertCurrent: () => void) {
  async function read<T>(name: string, fallback: T, valid: (value: unknown) => boolean): Promise<T> {
    assertCurrent();
    const file = path.join(dir, name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback);
      throw error;
    }
    assertCurrent();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SharedDatasetCorruptError(file);
    }
    if (!valid(value)) throw new SharedDatasetCorruptError(file);
    return value as T;
  }

  async function write(name: string, value: unknown): Promise<void> {
    assertCurrent();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      // The account may have changed while the temp file was written; never rename it into place.
      assertCurrent();
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  return {
    readState: () =>
      read<DatasetState>('state.v1.json', EMPTY_STATE, (v) =>
        isRecord(v) && ['home', 'replica', 'off'].includes(v.role as string) && Number.isInteger(v.homeEpoch),
      ),
    writeState: (state: DatasetState) => write('state.v1.json', state),
    readOutbox: () =>
      read<Outbox>('outbox.v1.json', EMPTY_OUTBOX, (v) =>
        isRecord(v) &&
        Number.isSafeInteger(v.nextSequence) &&
        Array.isArray(v.ops) &&
        isRecord(v.idMap) &&
        isRecord(v.bases),
      ),
    writeOutbox: (outbox: Outbox) => write('outbox.v1.json', outbox),
    readConflicts: () =>
      read<SharedDatasetConflict[]>('conflicts.v1.json', [], (v) => Array.isArray(v)),
    writeConflicts: (conflicts: SharedDatasetConflict[]) => write('conflicts.v1.json', conflicts),
    readReceipts: () => read<Receipts>('receipts.v1.json', {}, isRecord),
    writeReceipts: (receipts: Receipts) => write('receipts.v1.json', receipts),
  };
}

export type DatasetFiles = ReturnType<typeof createDatasetFiles>;
