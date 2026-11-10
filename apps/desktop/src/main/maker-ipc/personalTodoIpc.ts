import { ipcMain } from 'electron';
import { TodoError } from '@cindy/maker-shared/teammate-todo';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { PersonalTodoUpdate } from '../../shared/personalTodo.js';
import {
  notifyPersonalTodosChanged,
  openPersonalTodoStore,
  PersonalTodoOwnerChangedError,
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
          const scope = captureDataOwnerBroadcastScope();
          const { store, assertCurrent } = openPersonalTodoStore();
          const result = operation === 'list' ? await store.list() : await store.update(input);
          assertCurrent();
          if (operation === 'update') notifyPersonalTodosChanged(scope);
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
