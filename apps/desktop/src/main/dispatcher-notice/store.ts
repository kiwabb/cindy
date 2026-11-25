/**
 * 派发方通知的持久记录：每件任务一个小文件，放在账号隔离的用户数据目录下（不进项目目录、不改数据库）。
 * 原子写（临时文件 + rename），跨进程锁由调用方注入（生产用 withCrossProcessLock）。
 * 文件损坏时按「没有记录」处理并记日志，不让一件任务的坏文件拖垮其它任务。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { emptyRecord, type TaskRecord } from './core.js';

const VERSION = 1;
const MAX_BYTES = 256 * 1024;

export type FileLock = <T>(file: string, run: () => Promise<T>) => Promise<T>;

export interface DispatcherNoticeStore {
  read(taskId: string): Promise<TaskRecord>;
  /** 读-改-写；返回写入后的记录。change 返回 null 表示删除这件任务的记录。 */
  update(taskId: string, change: (record: TaskRecord) => TaskRecord | null): Promise<TaskRecord | null>;
  /** 所有还有派发关系或未结清请求的任务。 */
  list(): Promise<TaskRecord[]>;
  remove(taskId: string): Promise<void>;
}

export function createDispatcherNoticeStore(options: {
  dir: string;
  lock: FileLock;
  onCorrupt?: (taskId: string | null, error: unknown) => void;
}): DispatcherNoticeStore {
  const fileFor = (taskId: string) => path.join(options.dir, createHash('sha256').update(taskId).digest('hex').slice(0, 40) + '.json');

  const parse = (raw: string, taskId: string | null): TaskRecord | null => {
    try {
      const value = JSON.parse(raw) as { version?: unknown; record?: TaskRecord };
      const record = value?.record;
      if (value?.version !== VERSION || !record || typeof record.taskId !== 'string' || !Array.isArray(record.sent)
        || (taskId !== null && record.taskId !== taskId)) throw new Error('invalid dispatcher notice record');
      return record;
    } catch (error) {
      options.onCorrupt?.(taskId, error);
      return null;
    }
  };

  const readFile = async (file: string, taskId: string | null): Promise<TaskRecord | null> => {
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_BYTES) {
        options.onCorrupt?.(taskId, new Error('dispatcher notice record too large'));
        return null;
      }
      return parse(await fs.readFile(file, 'utf8'), taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  const read = async (taskId: string) => (await readFile(fileFor(taskId), taskId)) ?? emptyRecord(taskId);

  const write = async (file: string, record: TaskRecord) => {
    await fs.mkdir(options.dir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: VERSION, record }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  };

  return {
    read,
    async update(taskId, change) {
      const file = fileFor(taskId);
      await fs.mkdir(options.dir, { recursive: true });
      return options.lock(file + '.lock', async () => {
        const next = change((await readFile(file, taskId)) ?? emptyRecord(taskId));
        if (next === null || (!next.relation && !next.chain && next.sent.length === 0)) {
          await fs.rm(file, { force: true });
          return next;
        }
        await write(file, { ...next, taskId });
        return next;
      });
    },
    async list() {
      let names: string[];
      try {
        names = await fs.readdir(options.dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const records = await Promise.all(names.filter(name => name.endsWith('.json'))
        .map(name => readFile(path.join(options.dir, name), null)));
      return records.filter((record): record is TaskRecord => record !== null);
    },
    async remove(taskId) {
      const file = fileFor(taskId);
      await options.lock(file + '.lock', () => fs.rm(file, { force: true }));
    },
  };
}
