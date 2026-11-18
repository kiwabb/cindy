import { throwIpcError } from '../utils/ipcValidate.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildBotMemoryScopeKey, resolveMemoryScopeKey, type MakerMemoryStore } from '@cindy/maker-core';
import { createBotMemoryService } from './botMemoryService.js';
import { assertPrivateCompanionStore } from './privateCompanionStore.js';

export interface BotMemoryAccessOwner {
  root: string; canonicalSessionId: string | null; projectMode: boolean;
  /** Main-only opt-in selection, never accepted from memory IPC arguments. */
  privateCompanion: boolean;
  assertCurrent(): void;
  assertCompanionSelected?(): void;
  assertExclusiveWorkspace(workspace: string): Promise<void>;
}
export interface BotMemoryAccessDeps {
  readBot(botId: string): Promise<BotMemoryAccessOwner | null>;
  getStore(scopeKey: string): Promise<MakerMemoryStore>;
  requestRefresh(sessionId: string): Promise<unknown>;
}
/** Owner-local session metadata only; aliases cannot hide a shared workspace. */
export function assertExclusiveBotWorkspace(workspace: string, canonicalSessionId: string,
  sessions: ReadonlyArray<{ id: string; workingDir: string | null; projectDir: string | null }>): void {
  for (const session of sessions) {
    if (session.id === canonicalSessionId) continue;
    for (const candidate of [session.workingDir, session.projectDir]) {
      if (!candidate) continue;
      let resolved = path.resolve(candidate);
      try { resolved = fs.realpathSync(resolved); } catch { /* A missing path still cannot reuse the exact target. */ }
      if (resolved === workspace) throw new Error('COMPANION_SHARED_WORKSPACE');
    }
  }
}
/** Single production resolver for native memory service and the companion send assembly. */
export function createBotMemoryAccess(deps: BotMemoryAccessDeps) {
  let epoch = 0;
  const resolve = async (botId: string, mode: 'default' | 'private' | 'companion' = 'default') => {
    const capturedEpoch = epoch;
    const privateAccess = mode !== 'default';
    const owner = await deps.readBot(botId);
    if (!owner) throwIpcError('NOT_FOUND', 'Teammate not found');
    owner.assertCurrent();
    if (!botId || path.basename(botId) !== botId) throw new Error('COMPANION_PRIVATE_STORE_REQUIRED');
    const workspace = path.join(owner.root, 'bots', botId, 'workspace');
    if (mode === 'companion' && !owner.privateCompanion) throw new Error('COMPANION_PRIVATE_SELECTION_REQUIRED');
    if (privateAccess) {
      if (!owner.canonicalSessionId || fs.realpathSync(owner.root) !== owner.root
        || fs.realpathSync(workspace) !== workspace) throw new Error('COMPANION_PRIVATE_WORKSPACE_REQUIRED');
      await owner.assertExclusiveWorkspace(workspace); owner.assertCurrent();
    }
    // Opt-in companion facts never use a project scope, regardless of projectMode.
    const scopeKey = privateAccess || !owner.projectMode
      ? buildBotMemoryScopeKey(botId) : await resolveMemoryScopeKey(workspace);
    owner.assertCurrent();
    const store = await deps.getStore(scopeKey); owner.assertCurrent();
    const assertStore = () => {
      owner.assertCurrent();
      if (capturedEpoch !== epoch) throw new Error('BOT_MEMORY_ACCESS_INVALIDATED');
      if (mode === 'companion') owner.assertCompanionSelected?.();
      if (privateAccess) assertPrivateCompanionStore(owner.root, botId, store.getStorageIdentity());
    };
    assertStore();
    return { scopeKey, store, owner: { canonicalSessionId: owner.canonicalSessionId, scopeKey, assertCurrent: assertStore } };
  };
  const service = createBotMemoryService({ getStore: deps.getStore, readBot: async () => { throw new Error('USE_SHARED_RESOLVER'); },
    resolveStore: resolve, requestRefresh: deps.requestRefresh });
  const privateService = createBotMemoryService({ getStore: deps.getStore, readBot: async () => { throw new Error('USE_SHARED_RESOLVER'); },
    resolveStore: botId => resolve(botId, 'private'), requestRefresh: deps.requestRefresh });
  return { service, privateService, resolve, resolveCompanion: (botId: string) => resolve(botId, 'companion'),
    invalidate: () => { epoch++; service.disposePendingRefresh(); privateService.disposePendingRefresh(); } };
}
