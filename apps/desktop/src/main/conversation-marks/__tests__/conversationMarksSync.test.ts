/**
 * 测试价值
 * - 生产入口与可观察结果：真实的 createConversationMarkStore + createConversationMarksDataset 注册进
 *   真实的 createSharedDatasetsEngine（两台“电脑”，传输为经 JSON 往返的内存 fake）；断言两台电脑最终的
 *   标记文件内容、状态与只生效一次。
 * - 规则依据：docs/shared-datasets-plan.md §10 P5（第二个数据集只提供定义、不改同步层）、
 *   docs/product-rules/conversation-marks.md（标记跟着对话：电脑 id + 任务 id + 消息 clientId；删除可撤销）。
 * - 现有覆盖缺口：新模块；engine.test.ts 只用内存假数据集，没有真实文件存储与墓碑恢复。
 * - 最小失败输入：副本离线时新建并删除再撤销；加入同步时本机标记没有电脑 id；同一条两边同时改状态。
 * - tier：unit（临时目录 + 进程内 fake，不碰网络）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSharedDatasetsEngine } from '../../shared-datasets/engine.js';
import { createSharedDatasetRegistry } from '../../shared-datasets/registry.js';
import type { SharedDatasetsPorts } from '../../shared-datasets/types.js';
import { CONVERSATION_MARKS_DATASET_ID as DS, createConversationMarksDataset } from '../dataset.js';
import { createConversationMarkStore, MarkError } from '../store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-marks-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let worlds = 0;

function createWorld(ids: string[]) {
  const base = path.join(root, `w${worlds++}`);
  const online = new Set(ids);
  const timers: Array<{ delay: number; run: () => void; live: boolean }> = [];
  const devices = new Map<string, ReturnType<typeof device>>();
  let now = 1_000_000;

  function device(self: string) {
    const store = createConversationMarkStore(path.join(base, self, 'conversation-marks.v1.json'), () => {}, () => now);
    const listeners = new Set<() => void>();
    let selfKnown = true;
    const registry = createSharedDatasetRegistry();
    registry.register(
      createConversationMarksDataset({
        open: () => ({ store, assertCurrent: () => {} }),
        selfDeviceId: () => (selfKnown ? self : null),
        onLocalChange: (callback) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      }),
    );
    const ports: SharedDatasetsPorts = {
      selfDeviceId: () => self,
      captureScope: () => ({ owner: 'o1', baseDir: path.join(base, self, 'shared'), assertCurrent: () => {} }),
      listPeers: async () => ids.filter((id) => id !== self).map((id) => ({ deviceId: id, name: id, online: online.has(id) })),
      isPeerOnline: (id) => online.has(id),
      peerName: (id) => id,
      invoke: async (to, request) => {
        if (!online.has(to) || !online.has(self)) return { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'offline' } };
        try {
          const result = await devices.get(to)!.engine.handleRequest(self, JSON.parse(JSON.stringify(request)));
          return { ok: true, result: JSON.parse(JSON.stringify(result)) };
        } catch (error) {
          return { ok: false, error: { code: 'IPC_ERROR', message: (error as Error).message } };
        }
      },
      sendChanged: () => {},
      pushTargets: () => ids.filter((id) => id !== self && online.has(id)),
      now: () => now,
      schedule: (run, delay) => {
        const timer = { delay, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    };
    const engine = createSharedDatasetsEngine(ports, registry);
    return {
      engine,
      store,
      knowsSelfId: (known: boolean) => {
        selfKnown = known;
      },
      /** The write entry on a computer: local on off/home, queued on a replica (as access.ts does). */
      write: async (update: Record<string, unknown>) => {
        const outcome = await engine.writeDataset(DS, update as never, {
          localWrite: async () => {
            const mark = await store.update(update);
            for (const listener of listeners) listener();
            return mark;
          },
        });
        return outcome.local ? outcome.value : (outcome.result as unknown as { id: string; revision: number });
      },
      live: async () => (await store.readAll()).filter((mark) => !mark.deletedAt),
    };
  }

  for (const id of ids) devices.set(id, device(id));
  return {
    d: (id: string) => devices.get(id)!,
    online,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const creation = (requestId: string, extra: Record<string, unknown> = {}) => ({
  creationRequestId: requestId,
  sessionId: 'session-1',
  messageClientId: 'msg-1',
  messageCreatedAt: 1_700_000_000_000,
  authorRole: 'assistant',
  authorName: 'Researcher',
  quote: '先定目标听众',
  start: 4,
  end: 10,
  ...extra,
});

describe('conversation marks as a shared dataset', () => {
  it('a replica mark reaches the main computer once, keeps its conversation keys, and a delete can be undone', async () => {
    const { d, online } = createWorld(['H', 'R']);
    await d('H').engine.enable(DS);
    await d('R').engine.enable(DS);

    await d('R').write(creation('a', { hostDeviceId: 'H' }));
    await d('R').engine.syncNow(DS);
    const [onHome] = await d('H').live();
    expect(onHome).toMatchObject({ sessionId: 'session-1', hostDeviceId: 'H', messageClientId: 'msg-1', state: 'open' });

    // Main computer offline: discuss, delete and undo are queued, applied to the mirror at once.
    online.delete('H');
    const [mirrored] = await d('R').live();
    expect(mirrored.id).toBe(onHome.id);
    const discussed = await d('R').write({ id: mirrored.id, expectedRevision: mirrored.revision, operation: 'discuss' });
    const deleted = await d('R').write({ id: mirrored.id, expectedRevision: discussed.revision, operation: 'delete' });
    expect(await d('R').live()).toHaveLength(0);
    await d('R').write({ id: mirrored.id, expectedRevision: deleted.revision, operation: 'restore' });
    expect((await d('R').engine.getSyncStatus(DS)).pending).toBe(3);

    online.add('H');
    await d('R').engine.syncNow(DS);
    const home = await d('H').live();
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({ id: onHome.id, state: 'discussed', revision: onHome.revision + 3 });
    expect(await d('R').live()).toEqual(home);
    expect((await d('R').engine.getSyncStatus(DS)).pending).toBe(0);
  });

  it('joining carries this computer’s marks over and names their conversation with this computer’s id', async () => {
    const { d } = createWorld(['H', 'R']);
    await d('H').engine.enable(DS);
    await d('H').write(creation('h'));
    // Written while R did not know its own device id yet: the mark has no computer.
    d('R').knowsSelfId(false);
    await d('R').write(creation('r', { messageClientId: 'msg-r' }));
    expect((await d('R').live())[0].hostDeviceId).toBeUndefined();

    // R has its id by the time it joins: the carried-over creation is stamped with it.
    d('R').knowsSelfId(true);
    await d('R').engine.enable(DS);
    await d('R').engine.syncNow(DS);
    const home = await d('H').live();
    expect(home.map((mark) => mark.messageClientId).sort()).toEqual(['msg-1', 'msg-r']);
    expect(home.find((mark) => mark.messageClientId === 'msg-r')!.hostDeviceId).toBe('R');
  });

  it('the store refuses stale edits, keeps creations idempotent and restores a tombstone', async () => {
    const store = createConversationMarkStore(path.join(root, 'single', 'marks.json'));
    const first = await store.update(creation('same'));
    expect(await store.update(creation('same'))).toEqual(first);
    await expect(store.update(creation('same', { quote: 'other' }))).rejects.toEqual(new MarkError('CONFLICT'));
    const done = await store.update({ id: first.id, expectedRevision: 1, operation: 'discuss' });
    await expect(store.update({ id: first.id, expectedRevision: 1, operation: 'reopen' })).rejects.toEqual(
      new MarkError('CONFLICT'),
    );
    const gone = await store.update({ id: first.id, expectedRevision: done.revision, operation: 'delete' });
    expect(await store.list({ sessionId: 'session-1' }, [])).toEqual([]);
    await store.update({ id: first.id, expectedRevision: gone.revision, operation: 'restore' });
    expect(await store.list({ sessionId: 'session-1' }, [])).toHaveLength(1);
    // Stamped with this computer's device-link id in an earlier run; listed again before the
    // connection is back, when only the sign-in id is known (both name this computer).
    await store.update(creation('stamped', { sessionId: 'session-2', hostDeviceId: 'link-id' }));
    expect(await store.list({ sessionId: 'session-2' }, ['auth-id', 'link-id'])).toHaveLength(1);
    expect(await store.list({ sessionId: 'session-2', hostDeviceId: 'other' }, ['auth-id'])).toHaveLength(0);
  });
});
