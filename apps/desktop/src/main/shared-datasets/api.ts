import type { SharedDatasetRole } from '@cindy/device-link';
import type { SharedDatasetsEngine } from './engine.js';
import type {
  ConflictChoice,
  SharedDatasetConflict,
  SharedDatasetSyncStatus,
  SharedResult,
  SharedUpdate,
} from './types.js';

export { registerSharedDataset } from './registry.js';
export { SharedDatasetError } from './types.js';
export type {
  ConflictChoice,
  SharedDatasetConflict,
  SharedDatasetDefinition,
  SharedDatasetSyncStatus,
  SharedItem,
  SharedResult,
  SharedUpdate,
} from './types.js';

/**
 * What the rest of Desktop calls. Deliberately free of device-link imports so write entry points
 * (stores, IPC, Agent tools) can depend on it without a module cycle; the engine is installed by
 * `startSharedDatasets` in runtime.ts. Until then every dataset reads as `off`.
 */
let engine: SharedDatasetsEngine | null = null;

const changedListeners = new Set<(datasetId: string) => void>();
const statusListeners = new Set<(datasetId: string) => void>();
let detachChanged: (() => void) | null = null;
let detachStatus: (() => void) | null = null;

export function installSharedDatasetsEngine(next: SharedDatasetsEngine | null): void {
  detachChanged?.();
  detachChanged = null;
  detachStatus?.();
  detachStatus = null;
  engine = next;
  if (!next) return;
  detachStatus = next.onStatusChanged((datasetId) => {
    for (const listener of statusListeners) {
      try {
        listener(datasetId);
      } catch {
        // One subscriber must not block the others.
      }
    }
  });
  detachChanged = next.onChanged((datasetId) => {
    for (const listener of changedListeners) {
      try {
        listener(datasetId);
      } catch {
        // One subscriber must not block the others.
      }
    }
  });
}

function required(): SharedDatasetsEngine {
  if (!engine) throw new Error('shared datasets are not started');
  return engine;
}

export async function getSharedDatasetRole(id: string): Promise<SharedDatasetRole> {
  if (!engine) return 'off';
  try {
    return await engine.getRole(id);
  } catch {
    // No active account or an unregistered dataset: behaves as a plain local dataset.
    return 'off';
  }
}

export const enableSharedDataset = (id: string): Promise<SharedDatasetSyncStatus> => required().enable(id);
export const disableSharedDataset = (id: string): Promise<void> => required().disable(id);
export const setAsHome = (id: string): Promise<void> => required().setAsHome(id);
export const syncSharedDatasetNow = (id: string) => required().syncNow(id);
export const getSyncStatus = (id: string): Promise<SharedDatasetSyncStatus> => required().getSyncStatus(id);
export const listConflicts = (id: string): Promise<SharedDatasetConflict[]> => required().listConflicts(id);
export const resolveConflict = (id: string, conflictId: string, choice: ConflictChoice): Promise<void> =>
  required().resolveConflict(id, conflictId, choice);

/**
 * Replica write: applied to the mirror at once (the optimistic view) and queued for the home.
 * Rejects when the optimistic apply is refused, exactly like a local write would.
 */
export const enqueueReplicaUpdate = (
  id: string,
  update: SharedUpdate,
  options?: { waitMs?: number },
): Promise<SharedResult & { synced?: SharedResult }> => required().enqueueReplicaUpdate(id, update, options);

/**
 * The single write entry of a dataset: the role is read and the write done under the engine's own
 * lock, so a concurrent role change cannot lose the edit. Off / home run `localWrite` (the
 * dataset's own store write); a replica queues `update` for the home instead.
 */
export async function writeSharedDataset<T>(
  id: string,
  update: SharedUpdate,
  options: { localWrite: () => Promise<T>; waitMs?: number },
): Promise<{ local: true; value: T } | { local: false; result: SharedResult & { synced?: SharedResult } }> {
  if (!engine) return { local: true, value: await options.localWrite() };
  return engine.writeDataset(id, update, options);
}

/** Fires after the mirror or the home's data changed through sync, submit or conflict handling. */
export function onSharedDatasetChanged(listener: (datasetId: string) => void): () => void {
  changedListeners.add(listener);
  return () => changedListeners.delete(listener);
}

/** Fires on every data change and on status-only changes (peer presence, sync outcome). */
export function onSharedDatasetStatusChanged(listener: (datasetId: string) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Replica: the home's `extras` as of the last applied snapshot (e.g. its tag catalog). */
export async function getSharedDatasetExtras(id: string): Promise<unknown> {
  if (!engine) return undefined;
  try {
    return await engine.getExtras(id);
  } catch {
    return undefined;
  }
}
