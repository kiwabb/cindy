import path from 'node:path';
import { ipcMain } from 'electron';
import { TodoError } from '@cindy/maker-shared/teammate-todo';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { PersonalTodoUpdate } from '../../shared/personalTodo.js';
import { createPersonalTodoStore } from './personalTodoStore.js';

export function registerPersonalTodoIpc() {
  for (const operation of ['list', 'update'] as const) {
    ipcMain.handle(
      `local-db:personal-todos:${operation}`,
      async (event, input: PersonalTodoUpdate) => {
        assertTrustedAppRendererEvent(event);
        if (isDeviceLinkInvoke())
          throwIpcError('PRECONDITION_FAILED', 'Personal todos are local only');
        const owner = activeOwnerScopeKey();
        const assertCurrent = () => {
          if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey())
            throwIpcError('PRECONDITION_FAILED', 'Owner changed');
        };
        assertCurrent();
        const store = createPersonalTodoStore(
          path.join(ownerScopedUserDataPath(), 'personal-todos.v1.json'),
          assertCurrent,
        );
        try {
          const result = operation === 'list' ? await store.list() : await store.update(input);
          assertCurrent();
          return result;
        } catch (error) {
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
