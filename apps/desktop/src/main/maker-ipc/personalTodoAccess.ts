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
import { createPersonalTodoStore } from './personalTodoStore.js';

export const PERSONAL_TODO_FILE = 'personal-todos.v1.json';
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

/**
 * Personal todos share this device's task-tag catalog. Agent tools and remote controllers resolve
 * tag ids through it; an id missing from the catalog reads as untagged on every surface.
 */
export async function listPersonalTodoTagCatalog(): Promise<TaskTag[]> {
  return (await executeTaskTags({ action: 'list' })).tags;
}
