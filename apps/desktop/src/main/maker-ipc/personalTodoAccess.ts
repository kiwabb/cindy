import path from 'node:path';
import { BrowserWindow } from 'electron';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../device-link/broadcast-tap.js';
import type { TaskTag } from '@cindy/maker-shared';
import { executeTaskTags } from '../localDb/ipc/taskTags.js';
import type {
  PersonalTodo,
  PersonalTodoSyncChoice,
  PersonalTodoSyncConflict,
  PersonalTodoSyncStatus,
  PersonalTodoUpdate,
} from '../../shared/personalTodo.js';
import {
  writeSharedDataset,
  getSharedDatasetExtras,
  getSharedDatasetRole,
  disableSharedDataset,
  enableSharedDataset,
  getSyncStatus,
  listConflicts,
  resolveConflict,
  setAsHome,
} from '../shared-datasets/api.js';
import { createPersonalTodoStore } from './personalTodoStore.js';

export const PERSONAL_TODO_FILE = 'personal-todos.v1.json';
export const PERSONAL_TODOS_DATASET_ID = 'personal-todos';
export const PERSONAL_TODOS_CHANGED_CHANNEL = 'local-db:personal-todos:changed';

export class PersonalTodoOwnerChangedError extends Error {
  constructor() {
    super('Owner changed');
  }
}

/**
 * The single way to open the signed-in account's personal todo file. Every entry
 * (desktop UI, Agent tools, remote controllers, reminders) pins the owner it
 * started with and fails once the account boundary moves.
 */
export function openPersonalTodoStore() {
  const owner = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey())
      throw new PersonalTodoOwnerChangedError();
  };
  assertCurrent();
  const store = createPersonalTodoStore(
    path.join(ownerScopedUserDataPath(), PERSONAL_TODO_FILE),
    assertCurrent,
  );
  return { store, assertCurrent };
}

type ChangeListener = (scope: DataOwnerBroadcastScope) => void;
const listeners = new Set<ChangeListener>();

/** Remote resources and reminders subscribe here instead of each write path knowing them. */
export function onPersonalTodosChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call after any successful write, whichever surface made it. */
export function notifyPersonalTodosChanged(scope = captureDataOwnerBroadcastScope()): void {
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(PERSONAL_TODOS_CHANGED_CHANNEL, scope.ownerStamp);
    } catch {
      // A closing renderer must not affect the persisted write.
    }
  }
  for (const listener of listeners) {
    try {
      listener(scope);
    } catch {
      // One subscriber must not block the others.
    }
  }
}

/** This computer's own task-tag catalog (what the home publishes to its replicas, and what off/home read). */
export async function listLocalTaskTagCatalog(): Promise<TaskTag[]> {
  return (await executeTaskTags({ action: 'list' })).tags;
}

/**
 * The catalog personal todos resolve tag ids against. Off or home: this computer's own. Replica:
 * the home's catalog from the last snapshot, because the ids stored in the mirror are the home's
 * (an id missing from the catalog reads as untagged on every surface).
 */
export async function listPersonalTodoTagCatalog(): Promise<TaskTag[]> {
  if ((await getSharedDatasetRole(PERSONAL_TODOS_DATASET_ID)) === 'replica') {
    const extras = await getSharedDatasetExtras(PERSONAL_TODOS_DATASET_ID);
    return Array.isArray(extras) ? (extras as TaskTag[]) : [];
  }
  return listLocalTaskTagCatalog();
}

/** How long a replica write waits for its own flush to the main computer before answering `pending`. */
export const REPLICA_WRITE_WAIT_MS = 3000;

export interface PersonalTodoWriteResult {
  todo: PersonalTodo;
  /**
   * Replica only. `synced`: the main computer accepted the edit within the short wait (`todo` then
   * carries its id and revision). `pending`: applied here and queued; it goes out when the main computer
   * is reachable.
   */
  sync?: 'pending' | 'synced';
}

/**
 * The single write entry for personal todos; the desktop UI, Agent tools and the phone's remote
 * resource all come through it. Off / home write the account file directly (the home's change
 * push is driven by `notifyPersonalTodosChanged`); a replica applies the edit to its mirror and
 * queues it for the home instead, so there is never a second writer.
 */
export async function writePersonalTodo(
  input: PersonalTodoUpdate,
  scope = captureDataOwnerBroadcastScope(),
): Promise<PersonalTodoWriteResult> {
  const { store, assertCurrent } = openPersonalTodoStore();
  // Role check and write happen under the sync layer's own lock, so a demotion cannot slip in
  // between and wipe the edit from the mirror.
  const outcome = await writeSharedDataset(
    PERSONAL_TODOS_DATASET_ID,
    { ...input },
    { waitMs: REPLICA_WRITE_WAIT_MS, localWrite: () => store.update(input) },
  );
  assertCurrent();
  if (outcome.local) {
    notifyPersonalTodosChanged(scope);
    return { todo: outcome.value };
  }
  const queued = outcome.result;
  const todo = queued as unknown as PersonalTodo;
  // The shared-datasets layer announces the mirror change itself.
  return queued.synced
    ? { todo: { ...todo, id: queued.synced.id, revision: queued.synced.revision }, sync: 'synced' }
    : { todo, sync: 'pending' };
}

export interface PersonalTodoSyncSummary {
  role: 'home' | 'replica';
  homeName?: string;
  homeOnline: boolean;
  /** Edits made here that the main computer has not accepted yet. */
  pending: number;
  /** Edits the main computer refused; they wait for the owner's choice. */
  conflicts: number;
}

/** What an Agent needs to know about multi-computer sync; undefined when sync is off. */
export async function personalTodoSyncSummary(): Promise<PersonalTodoSyncSummary | undefined> {
  const role = await getSharedDatasetRole(PERSONAL_TODOS_DATASET_ID);
  if (role === 'off') return undefined;
  try {
    const status = await getSyncStatus(PERSONAL_TODOS_DATASET_ID);
    if (status.role === 'off') return undefined;
    return {
      role: status.role,
      ...(status.homeName ? { homeName: status.homeName } : {}),
      homeOnline: status.homeOnline,
      pending: status.pending,
      conflicts: status.conflicts,
    };
  } catch {
    return undefined;
  }
}

export async function readPersonalTodoSyncStatus(): Promise<PersonalTodoSyncStatus> {
  const status = await getSyncStatus(PERSONAL_TODOS_DATASET_ID);
  const tags = status.role === 'replica' ? await listPersonalTodoTagCatalog() : undefined;
  return {
    role: status.role,
    ...(status.homeName ? { homeName: status.homeName } : {}),
    homeOnline: status.homeOnline,
    pending: status.pending,
    conflicts: status.conflicts,
    ...(status.lastSyncedAt ? { lastSyncedAt: status.lastSyncedAt } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    ...(tags ? { tags } : {}),
  };
}

export async function listPersonalTodoSyncConflicts(): Promise<PersonalTodoSyncConflict[]> {
  return (await listConflicts(PERSONAL_TODOS_DATASET_ID)).map((conflict) => {
    const update = conflict.update as PersonalTodoUpdate;
    return {
      id: conflict.id,
      code: conflict.code,
      ...(typeof update.id === 'string' ? { todoId: update.id } : { draft: update }),
    };
  });
}

/** The one place sync is managed from: the desktop page and the Agent tools both call these. */
export const personalTodoSyncActions = {
  async enable() {
    await enableSharedDataset(PERSONAL_TODOS_DATASET_ID);
    return readPersonalTodoSyncStatus();
  },
  async disable() {
    await disableSharedDataset(PERSONAL_TODOS_DATASET_ID);
    return readPersonalTodoSyncStatus();
  },
  async setAsHome() {
    await setAsHome(PERSONAL_TODOS_DATASET_ID);
    return readPersonalTodoSyncStatus();
  },
  async resolve(conflictId: string, choice: PersonalTodoSyncChoice) {
    await resolveConflict(PERSONAL_TODOS_DATASET_ID, conflictId, choice);
    return readPersonalTodoSyncStatus();
  },
};
