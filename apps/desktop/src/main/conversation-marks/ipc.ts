import { ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { ConversationMarkScope, ConversationMarkUpdate } from '../../shared/conversationMarks.js';
import {
  ConversationMarkOwnerChangedError,
  listConversationMarks,
  readConversationMarkSyncStatus,
  writeConversationMark,
} from './access.js';
import { MarkError } from './store.js';

function scopeOf(raw: unknown): ConversationMarkScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'scope');
  const { sessionId, hostDeviceId } = raw as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throwIpcError('INVALID_PARAMS', 'sessionId');
  if (hostDeviceId != null && (typeof hostDeviceId !== 'string' || !hostDeviceId || hostDeviceId.length > 200))
    throwIpcError('INVALID_PARAMS', 'hostDeviceId');
  return { sessionId, ...(hostDeviceId ? { hostDeviceId } : {}) };
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConversationMarkOwnerChangedError) throwIpcError('PRECONDITION_FAILED', 'Owner changed');
    if (error instanceof MarkError) {
      throwIpcError(
        error.code === 'CONFLICT' ? 'ALREADY_EXISTS' : error.code === 'NOT_FOUND' ? 'NOT_FOUND' : error.code === 'INVALID_INPUT' ? 'INVALID_PARAMS' : 'PRECONDITION_FAILED',
        error.code,
      );
    }
    throwIpcError('INTERNAL', 'Conversation marks unavailable');
  }
}

/**
 * The owner's marks on this computer. Trusted app renderer only; a remote controller never reaches
 * them (marks of a conversation on another computer are kept here, keyed by that computer's id).
 */
export function registerConversationMarksIpc(): void {
  const guard = (event: Parameters<typeof assertTrustedAppRendererEvent>[0]) => {
    assertTrustedAppRendererEvent(event);
    if (isDeviceLinkInvoke()) throwIpcError('PRECONDITION_FAILED', 'Conversation marks are local only');
  };
  ipcMain.handle('conversation-marks:list', async (event, scope: unknown) => {
    guard(event);
    const parsed = scopeOf(scope);
    return call(() => listConversationMarks(parsed));
  });
  ipcMain.handle('conversation-marks:update', async (event, update: unknown) => {
    guard(event);
    if (!update || typeof update !== 'object' || Array.isArray(update)) throwIpcError('INVALID_PARAMS', 'update');
    return call(() => writeConversationMark(update as ConversationMarkUpdate));
  });
  ipcMain.handle('conversation-marks:sync-status', async (event) => {
    guard(event);
    return call(readConversationMarkSyncStatus);
  });
}
