import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryTurnReceipt, MemoryTurnReceiptStore } from './turn-context.js';

/**
 * Host supplies a private user-data directory, never a workdir or credential location.
 * One immutable receipt per logical input. Same-directory hard-link publishes exclusively:
 * a crash before publish leaves only a temporary file, never a partially committed receipt.
 * No fallback that overwrites an existing receipt on filesystems without hard-link support.
 */
export class FileMemoryTurnReceipts implements MemoryTurnReceiptStore {
  constructor(private readonly directory: string, private readonly assertCurrent: () => void) {
    if (!path.isAbsolute(directory)) throw new Error('MEMORY_RECEIPT_DIRECTORY_REQUIRED');
  }

  private filename(scope: string, requestId: string): string {
    const key = createHash('sha256').update(JSON.stringify([scope, requestId])).digest('hex');
    return path.join(this.directory, `${key}.json`);
  }

  async get(scope: string, requestId: string): Promise<MemoryTurnReceipt | null> {
    this.assertCurrent();
    let file;
    try {
      file = await open(this.filename(scope, requestId), 'r');
      if ((await file.stat()).size > 16384) throw new Error('INVALID_MEMORY_RECEIPT');
      const value = JSON.parse(await file.readFile('utf8')) as MemoryTurnReceipt;
      if (value.version !== 1 || value.scope !== scope || value.requestId !== requestId
        || !/^[a-f0-9]{64}$/.test(value.inputHash) || !/^[a-f0-9]{64}$/.test(value.replyHash)
        || !Array.isArray(value.memoryFiles) || value.memoryFiles.length > 5
        || value.memoryFiles.some(name => typeof name !== 'string' || name.length > 240)) {
        throw new Error('INVALID_MEMORY_RECEIPT');
      }
      this.assertCurrent();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally { await file?.close(); }
  }

  async commitOnce(receipt: MemoryTurnReceipt, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.assertCurrent();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.assertCurrent();
    const destination = this.filename(receipt.scope, receipt.requestId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(receipt));
      await file.sync();
      await file.close();
      file = undefined;
      this.assertCurrent();
      signal?.throwIfAborted();
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.get(receipt.scope, receipt.requestId);
        if (!existing || existing.inputHash !== receipt.inputHash) throw new Error('MEMORY_TURN_ID_CONFLICT');
      }
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}
