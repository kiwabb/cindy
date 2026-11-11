import { BrowserWindow, ipcMain } from 'electron';
import { TodoError } from '@cindy/maker-shared/teammate-todo';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type {
  PersonalTodoSyncChoice,
  PersonalTodoUpdate,
} from '../../shared/personalTodo.js';
import { onSharedDatasetStatusChanged } from '../shared-datasets/api.js';
import {
  listPersonalTodoSyncConflicts,
  openPersonalTodoStore,
  PERSONAL_TODOS_DATASET_ID,
  PersonalTodoOwnerChangedError,
  personalTodoSyncActions,
  readPersonalTodoSyncStatus,
  writePersonalTodo,
} from './personalTodoAccess.js';

export function registerPersonalTodoIpc() {
  for (const operation of ['list', 'update'] as const) {
    ipcMain.handle(
      `local-db:personal-todos:${operation}`,
      async (event, input: PersonalTodoUpdate) => {
        assertTrustedAppRendererEvent(event);
        // Remote controllers use the personal-todos remote resource, never this channel.
        if (isDeviceLinkInvoke())
          throwIpcError('PRECONDITION_FAILED', 'Personal todos are local only');
        try {
          if (operation === 'update') {
            // One write entry for every surface; a replica queues the edit for the main computer.
            return (await writePersonalTodo(input, captureDataOwnerBroadcastScope())).todo;
          }
          const { store, assertCurrent } = openPersonalTodoStore();
          const result = await store.list();
          assertCurrent();
          return result;
        } catch (error) {
          if (error instanceof PersonalTodoOwnerChangedError)
            throwIpcError('PRECONDITION_FAILED', 'Owner changed');
          if (error instanceof TodoError) {
            throwIpcError(
              error.code === 'CONFLICT'
                ? 'ALREADY_EXISTS'
                : error.code === 'NOT_FOUND'
                  ? 'NOT_FOUND'
                  : 'INVALID_PARAMS',
              error.code,
            );
          }
          throwIpcError('INTERNAL', 'Personal todo storage unavailable');
        }
      },
    );
  }
}

export const PERSONAL_TODOS_SYNC_CHANGED_CHANNEL = 'local-db:personal-todos:sync:changed';

function syncErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'SYNC_FAILED';
}

/** Sync failures reach the page as a stable code; the page decides what to show. */
async function syncCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PersonalTodoOwnerChangedError)
      throwIpcError('PRECONDITION_FAILED', 'Owner changed');
    const code = syncErrorCode(error);
    throwIpcError(code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED', code);
  }
}

/** Trusted app renderer only; remote controllers never reach sync management. */
export function registerPersonalTodoSyncIpc() {
  const guard = (event: Parameters<typeof assertTrustedAppRendererEvent>[0]) => {
    assertTrustedAppRendererEvent(event);
    if (isDeviceLinkInvoke()) throwIpcError('PRECONDITION_FAILED', 'Personal todos are local only');
  };
  ipcMain.handle('local-db:personal-todos:sync:status', async (event) => {
    guard(event);
    return syncCall(readPersonalTodoSyncStatus);
  });
  ipcMain.handle('local-db:personal-todos:sync:enable', async (event) => {
    guard(event);
    return syncCall(personalTodoSyncActions.enable);
  });
  ipcMain.handle('local-db:personal-todos:sync:disable', async (event) => {
    guard(event);
    return syncCall(personalTodoSyncActions.disable);
  });
  ipcMain.handle('local-db:personal-todos:sync:set-home', async (event) => {
    guard(event);
    return syncCall(personalTodoSyncActions.setAsHome);
  });
  ipcMain.handle(
    'local-db:personal-todos:sync:conflicts',
    async (event) => {
      guard(event);
      return syncCall(listPersonalTodoSyncConflicts);
    },
  );
  ipcMain.handle(
    'local-db:personal-todos:sync:resolve',
    async (event, conflictId: unknown, choice: unknown) => {
      guard(event);
      if (
        typeof conflictId !== 'string' ||
        !conflictId ||
        conflictId.length > 64 ||
        (choice !== 'mine' && choice !== 'theirs')
      )
        throwIpcError('INVALID_PARAMS', 'conflictId/choice');
      return syncCall(() =>
        personalTodoSyncActions.resolve(conflictId, choice as PersonalTodoSyncChoice),
      );
    },
  );
  // Status changes (role, pending count, conflicts) without a todo change also reach the page.
  onSharedDatasetStatusChanged((id) => {
    if (id !== PERSONAL_TODOS_DATASET_ID) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      try {
        window.webContents.send(PERSONAL_TODOS_SYNC_CHANGED_CHANNEL);
      } catch {
        // A closing renderer must not affect sync.
      }
    }
  });
}
