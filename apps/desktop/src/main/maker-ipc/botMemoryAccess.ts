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
/** Working in a teammate project does not grant access to its private store.
 * Ordinary project tasks and this bot's linked tasks may share the workspace;
 * only a task bound to a different bot is an ownership conflict. The separate
 * scope/realpath/database guard below remains the private-memory boundary. */
export function assertExclusiveBotWorkspace(workspace: string, botId: string,
  sessions: ReadonlyArray<{ id: string; botId: string | null; workingDir: string | null; projectDir: string | null }>): void {
  const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  let target = path.resolve(workspace);
  try { target = fs.realpathSync(target); } catch { /* Compare missing paths lexically. */ }
  for (const session of sessions) {
    if (!session.botId || session.botId === botId) continue;
    for (const candidate of [session.workingDir, session.projectDir]) {
      if (!candidate) continue;
      let resolved = path.resolve(candidate);
      try { resolved = fs.realpathSync(resolved); } catch { /* A missing path still cannot reuse the exact target. */ }
      if (comparable(resolved) === comparable(target)) throw new Error('COMPANION_SHARED_WORKSPACE');
    }
  }
}
/** Single production resolver for native memory service and the companion send assembly. */
export function createBotMemoryAccess(deps: BotMemoryAccessDeps) {
  let epoch = 0;
  const botEpochs = new Map<string, number>();
  const canonicalSessions = new Map<string, string>();
  const resolve = async (botId: string, mode: 'default' | 'private' | 'companion' = 'default') => {
    const capturedEpoch = epoch, capturedBotEpoch = botEpochs.get(botId) ?? 0;
    const privateAccess = mode !== 'default';
    const owner = await deps.readBot(botId);
    if (!owner) throwIpcError('NOT_FOUND', 'Teammate not found');
    owner.assertCurrent();
    if (owner.canonicalSessionId) canonicalSessions.set(botId, owner.canonicalSessionId);
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
      if (capturedEpoch !== epoch || capturedBotEpoch !== (botEpochs.get(botId) ?? 0)) throw new Error('BOT_MEMORY_ACCESS_INVALIDATED');
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
    invalidate: (botId?: string) => {
      if (botId !== undefined) {
        botEpochs.set(botId, (botEpochs.get(botId) ?? 0) + 1);
        const sessionId = canonicalSessions.get(botId);
        if (sessionId) { service.disposePendingRefresh(sessionId); privateService.disposePendingRefresh(sessionId); }
        canonicalSessions.delete(botId); return;
      }
      epoch++; canonicalSessions.clear(); botEpochs.clear(); service.disposePendingRefresh(); privateService.disposePendingRefresh();
    } };
}
