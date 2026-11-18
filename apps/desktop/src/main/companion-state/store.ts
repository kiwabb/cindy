import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { validateState } from './validation.js';
import { initialState, assertId, type Scope, type State } from './types.js';

export type TransactionLock = <T>(file: string, run: () => Promise<T>) => Promise<T>;
export interface StateStore {
  read(): Promise<State>;
  update<T>(revision: number | undefined, mutate: (state: State) => T): Promise<T>;
}
const MAX_BYTES = 4 * 1024 * 1024;
/** Private owner root supplied by Main; never a project/workdir or a guessed cwd. */
export function createStateStore(ownerRoot: string, scope: Scope, assertCurrent: () => void,
  lock: TransactionLock): StateStore {
  assertId(scope.ownerId); assertId(scope.botId);
  if (!path.isAbsolute(ownerRoot)) throw new Error('COMPANION_PRIVATE_ROOT_REQUIRED');
  const directory = path.join(ownerRoot, 'companion-state');
  const key = createHash('sha256').update(JSON.stringify([scope.ownerId, scope.botId])).digest('hex');
  const file = path.join(directory, `${key}.json`);
  async function read(): Promise<State> {
    assertCurrent();
    try {
      if ((await fs.realpath(directory)) !== directory) throw new Error('COMPANION_PRIVATE_ROOT_REDIRECTED');
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let data: State;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('COMPANION_STATE_INVALID_FILE');
        data = JSON.parse(await handle.readFile('utf8')) as State;
      } finally { await handle.close(); }
      validateState(data);
      if (data.ownerId !== scope.ownerId || data.botId !== scope.botId)
        throw new Error('COMPANION_STATE_INVALID');
      assertCurrent();
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialState(scope);
      throw error; // A damaged file is never replaced with defaults.
    }
  }
  return { read, async update(revision, mutate) {
    assertCurrent();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // Reject redirected storage. Host owner-root verification remains mandatory.
    if ((await fs.realpath(directory)) !== directory) throw new Error('COMPANION_PRIVATE_ROOT_REDIRECTED');
    return lock(`${file}.lock`, async () => {
      assertCurrent();
      const state = await read();
      if (revision !== undefined && state.revision !== revision) throw new Error('COMPANION_CAS_CONFLICT');
      const result = mutate(state);
      state.revision++;
      validateState(state);
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('COMPANION_STATE_FULL');
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        assertCurrent();
        await fs.rename(temp, file);
        return result;
      } finally { await fs.rm(temp, { force: true }); }
    });
  } };
}
