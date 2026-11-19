import fs from 'node:fs';
import path from 'node:path';

export interface CompanionStoreIdentity { scopeKey: string; storageDir: string; databasePath: string }
/** Fail closed: project scope is shared by project tasks, even under a bot's own workspace. */
export function assertPrivateCompanionStore(ownerRoot: string, botId: string, identity: CompanionStoreIdentity): void {
  const expected = path.join(ownerRoot, 'bots', botId, 'memories');
  const db = path.join(expected, 'fts.db');
  if (!path.isAbsolute(ownerRoot) || !botId || path.basename(botId) !== botId
    || identity.scopeKey !== `bot:${encodeURIComponent(botId.trim())}`
    || identity.storageDir !== expected || identity.databasePath !== db
    || fs.realpathSync(ownerRoot) !== ownerRoot || fs.realpathSync(expected) !== expected
    || fs.realpathSync(db) !== db || !fs.statSync(db).isFile() || fs.statSync(db).nlink !== 1) {
    throw new Error('COMPANION_PRIVATE_STORE_REQUIRED');
  }
}
