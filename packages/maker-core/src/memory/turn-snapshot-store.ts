import { validateMemoryTurnContribution } from './turn-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryTurnSnapshot, MemoryTurnSnapshotStore } from './turn-context.js';

function validate(value: MemoryTurnSnapshot, scope: string, requestId: string): void {
  if (value?.contribution !== undefined) validateMemoryTurnContribution(value.contribution);
  if (value?.userSource && (typeof value.userSource.messageId !== 'string' || !value.userSource.messageId || value.userSource.messageId.length > 200 || typeof value.userSource.text !== 'string' || Buffer.byteLength(value.userSource.text) > 32768)) throw new Error('INVALID_MEMORY_SNAPSHOT_SOURCE');
  if (value?.recovery && (typeof value.recovery.sourceRequestId !== 'string' || !value.recovery.sourceRequestId
    || typeof value.recovery.logicalRequestId !== 'string' || !value.recovery.logicalRequestId
    || value.recovery.sourceRequestId.length > 200 || value.recovery.logicalRequestId.length > 200
    || !/^[a-f0-9]{64}$/.test(value.recovery.logicalInputHash))) throw new Error('INVALID_MEMORY_SNAPSHOT');
  if (value?.version !== 1 || value.scope !== scope || value.requestId !== requestId
    || !/^[a-f0-9]{64}$/.test(value.inputHash) || !Array.isArray(value.recalled) || value.recalled.length > 5
    || value.recalled.some(hit => !hit || typeof hit.file !== 'string' || hit.file.length > 240
      || typeof hit.title !== 'string' || hit.title.length > 160
      || typeof hit.excerpt !== 'string' || hit.excerpt.length > 500)) throw new Error('INVALID_MEMORY_SNAPSHOT');
}

/** Private host-owned storage. Prepared snapshots contain memory excerpts: never export as telemetry. */
export class FileMemoryTurnSnapshots implements MemoryTurnSnapshotStore {
  constructor(private readonly directory: string, private readonly assertCurrent: () => void) {
    if (!path.isAbsolute(directory)) throw new Error('MEMORY_SNAPSHOT_DIRECTORY_REQUIRED');
  }
  private filename(scope: string, requestId: string): string {
    return path.join(this.directory,
      `${createHash('sha256').update(JSON.stringify([scope, requestId])).digest('hex')}.json`);
  }
  async get(scope: string, requestId: string): Promise<MemoryTurnSnapshot | null> {
    this.assertCurrent();
    let file;
    try {
      file = await open(this.filename(scope, requestId), 'r');
      if ((await file.stat()).size > 65536) throw new Error('INVALID_MEMORY_SNAPSHOT');
      const value = JSON.parse(await file.readFile('utf8')) as MemoryTurnSnapshot;
      validate(value, scope, requestId); this.assertCurrent(); return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally { await file?.close(); }
  }
  async prepareOnce(snapshot: MemoryTurnSnapshot, signal: AbortSignal): Promise<MemoryTurnSnapshot> {
    validate(snapshot, snapshot.scope, snapshot.requestId);
    const current = () => { signal.throwIfAborted(); this.assertCurrent(); };
    current();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    current();
    const destination = this.filename(snapshot.scope, snapshot.requestId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(snapshot));
      await file.sync(); await file.close(); file = undefined;
      current();
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      current();
      const saved = await this.get(snapshot.scope, snapshot.requestId);
      if (!saved || saved.inputHash !== snapshot.inputHash
        || JSON.stringify(saved.recovery) !== JSON.stringify(snapshot.recovery)) throw new Error('MEMORY_TURN_ID_CONFLICT');
      return saved;
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
}
