import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';

import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import {
  LEARNING_CHANGED_CHANNEL,
  LEARNING_SNAPSHOT_CHANNEL,
  type LearningSnapshot,
} from '../../shared/learning.js';
import { createLearningGoalsReader, createLearningGoalsWatcher } from './learningGoals.js';

const log = createLogger('learning');

let state: {
  owner: string;
  reader: ReturnType<typeof createLearningGoalsReader>;
  watcher: ReturnType<typeof createLearningGoalsWatcher>;
} | null = null;

function announceChange(): void {
  const scope = captureDataOwnerBroadcastScope();
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(LEARNING_CHANGED_CHANNEL, scope.ownerStamp);
    } catch {
      // A closing window must not affect the others.
    }
  }
}

/** The signed-in account's goals; switching accounts drops the previous reader and its watchers. */
async function readLearningSnapshot(): Promise<LearningSnapshot> {
  const owner = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending()) throwIpcError('PRECONDITION_FAILED', 'Owner changed');
  if (state?.owner !== owner) {
    state?.watcher.close();
    const root = path.join(ownerScopedUserDataPath(), 'bots');
    state = {
      owner,
      reader: createLearningGoalsReader(() => root),
      watcher: createLearningGoalsWatcher(announceChange),
    };
  }
  const current = state;
  const snapshot = await current.reader.snapshot();
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
    throwIpcError('PRECONDITION_FAILED', 'Owner changed');
  current.watcher.sync(current.reader.goalRoots());
  return snapshot;
}

/** Local, trusted renderer only: remote controllers and the phone never read learning goals. */
export function registerLearningIpc(): void {
  ipcMain.handle(LEARNING_SNAPSHOT_CHANNEL, async (event) => {
    assertTrustedAppRendererEvent(event);
    if (isDeviceLinkInvoke()) throwIpcError('PRECONDITION_FAILED', 'Learning goals are local only');
    try {
      return await readLearningSnapshot();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('learning snapshot failed', { name: error instanceof Error ? error.name : 'unknown' });
      throwIpcError('INTERNAL', 'Learning goals unavailable');
    }
  });
}
