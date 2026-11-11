import type { DataOwnerBroadcastScope } from '../../device-link/broadcast-tap.js';

type Listener = (scope: DataOwnerBroadcastScope) => void;
const listeners = new Set<Listener>();

/**
 * Main-process consumers of the task-tag catalog (personal todos resolve tag names through it)
 * subscribe here, so `taskTags.ts` does not need to know who reads tags.
 */
export function onTaskTagCatalogChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitTaskTagCatalogChanged(scope: DataOwnerBroadcastScope): void {
  for (const listener of listeners) {
    try {
      listener(scope);
    } catch {
      // One consumer must not fail a committed tag write.
    }
  }
}
