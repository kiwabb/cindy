/**
 * 测试价值
 * - 生产入口与可观察结果：createSharedDatasetsEngine 的 handleRequest / enable / syncNow /
 *   enqueueReplicaUpdate / setAsHome / reconcile / resolveConflict；断言各台"电脑"最终的数据、
 *   角色、待发队列和冲突列表，传输用内存 fake（经 JSON 往返，等同线上帧）。
 * - 规则依据：docs/shared-datasets-plan.md §4.2–4.3（回执幂等、离线待发、冲突不覆盖、换主力电脑）、
 *   credentials-and-local-storage.md（账号代次）。
 * - 现有覆盖缺口：新模块，无其它覆盖；这些是丢数据/重复写入/串账号类故障的唯一防线。
 * - 最小失败输入：同一 sequence 提交两次；主力离线时对同一条连续编辑；两台电脑同时自称主力；
 *   同步中途切换账号。
 * - tier：unit（进程内 fake + 临时目录，不碰网络）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createSharedDatasetsEngine, PUSH_DEBOUNCE_MS } from '../engine.js';
import { createSharedDatasetRegistry } from '../registry.js';
import { SharedDatasetError, type SharedDatasetsPorts, type SharedUpdate } from '../types.js';

interface Note {
  id: string;
  revision: number;
  key: string;
  title: string;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-datasets-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let worldCounter = 0;

function createWorld(ids: string[]) {
  const base = path.join(root, `w${worldCounter++}`);
  const world = {
    owners: Object.fromEntries(ids.map((id) => [id, 'o1'])) as Record<string, string>,
    now: 1_000_000,
    online: new Set(ids),
    pushes: [] as Array<{ to: string; frame: { dataset: string; cursor: string } }>,
    timers: [] as Array<{ delay: number; run: () => void; live: boolean }>,
    beforeInvoke: undefined as undefined | ((to: string, request: { action: string }) => void),
    devices: new Map<string, Device>(),
  };

  function createDevice(self: string) {
    const stores = new Map<string, Map<string, Note>>();
    const store = () => {
      if (!stores.has(world.owners[self])) stores.set(world.owners[self], new Map());
      return stores.get(world.owners[self])!;
    };
    let counter = 0;
    let applied = 0;
    const registry = createSharedDatasetRegistry();
    registry.register<Note, undefined>({
      id: 'notes',
      schemaVersion: 1,
      readItems: async () => [...store().values()].map((item) => ({ ...item })),
      cursorOf: (items) =>
        items
          .map((item) => `${item.id}:${item.revision}`)
          .sort()
          .join(','),
      replaceMirror: async (items, removeIds) => {
        const current = store();
        for (const id of removeIds) current.delete(id);
        for (const item of items) current.set(item.id, { ...item });
      },
      applySubmit: async (update) => {
        const current = store();
        if (!update.id) {
          const key = `c:${update.crid as string}`;
          const existing = [...current.values()].find((item) => item.key === key);
          if (existing) {
            if (existing.title !== update.title) throw new SharedDatasetError('CONFLICT');
            return { id: existing.id, revision: existing.revision };
          }
          applied += 1;
          const note: Note = {
            id: `${self}-${++counter}`,
            revision: 1,
            key,
            title: update.title as string,
          };
          current.set(note.id, note);
          return { id: note.id, revision: 1 };
        }
        const item = current.get(update.id);
        if (!item) throw new SharedDatasetError('NOT_FOUND');
        // Like the real personal-todo store: an edit must name the revision it is based on.
        if (update.expectedRevision !== item.revision) throw new SharedDatasetError('STALE');
        applied += 1;
        item.title = update.title as string;
        item.revision += 1;
        return { id: item.id, revision: item.revision };
      },
      onLocalChange: () => () => {},
      creationUpdate: (item, requestId) => ({ crid: requestId, title: item.title }),
      reviseUpdate: (local) => ({ title: local.title }),
    });
    const ports: SharedDatasetsPorts = {
      selfDeviceId: () => self,
      captureScope: () => {
        const owner = world.owners[self];
        return {
          owner,
          baseDir: path.join(base, self, owner),
          assertCurrent: () => {
            if (world.owners[self] !== owner) throw new Error('owner changed');
          },
        };
      },
      listPeers: async () =>
        ids
          .filter((id) => id !== self)
          .map((id) => ({ deviceId: id, name: id, online: world.online.has(id) })),
      isPeerOnline: (id) => world.online.has(id),
      peerName: (id) => id,
      invoke: async (to, request) => {
        if (!world.online.has(to) || !world.online.has(self)) {
          return { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'offline' } };
        }
        world.beforeInvoke?.(to, request);
        try {
          const result = await world.devices
            .get(to)!
            .engine.handleRequest(self, JSON.parse(JSON.stringify(request)));
          return { ok: true, result: JSON.parse(JSON.stringify(result)) };
        } catch (error) {
          return { ok: false, error: { code: 'IPC_ERROR', message: (error as Error).message } };
        }
      },
      sendChanged: (to, frame) => world.pushes.push({ to, frame }),
      pushTargets: () => ids.filter((id) => id !== self && world.online.has(id)),
      now: () => world.now,
      schedule: (run, delay) => {
        const timer = { delay, run, live: true };
        world.timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    };
    const engine = createSharedDatasetsEngine(ports, registry);
    return {
      id: self,
      engine,
      get applied() {
        return applied;
      },
      /** A write that bypasses the engine, like the UI of a home computer. */
      write: (update: SharedUpdate) => registry.get('notes')!.applySubmit(update),
      /** Plants an item as if it had been created before sync (ids/revisions of a restored copy). */
      seed: (note: Note) => store().set(note.id, { ...note }),
      items: () => [...store().values()].sort((a, b) => a.title.localeCompare(b.title)),
    };
  }
  type Device = ReturnType<typeof createDevice>;

  for (const id of ids) world.devices.set(id, createDevice(id));
  return {
    world,
    d: (id: string) => world.devices.get(id)!,
    /** Timers run by hand so no test waits in real time. */
    async runTimers(delay: number) {
      for (const timer of world.timers.filter((t) => t.live && t.delay === delay)) {
        timer.live = false;
        timer.run();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

type World = ReturnType<typeof createWorld>;

const submit = (
  home: ReturnType<World['d']>,
  sequence: number,
  update: SharedUpdate,
  source = 'replica:R',
) => home.engine.handleRequest('R', { action: 'submit', dataset: 'notes', source, sequence, update });

describe('shared dataset engine', () => {
  it('home applies a submitted sequence once and refuses gaps, reused sequences and spoofed sources', async () => {
    const { d } = createWorld(['H', 'R']);
    const home = d('H');
    await home.engine.enable('notes');
    const first = await submit(home, 1, { crid: 'a', title: 'one' });
    expect(await submit(home, 1, { crid: 'a', title: 'one' })).toEqual(first);
    expect(home.applied).toBe(1);
    expect(await submit(home, 3, { crid: 'c', title: 'three' })).toEqual({
      error: { code: 'OUT_OF_ORDER', expectedSequence: 2 },
    });
    // A source that lost its history and reuses sequence 1 must not be answered with the old result.
    expect(await submit(home, 1, { crid: 'b', title: 'other' })).toEqual({
      error: { code: 'OUT_OF_ORDER', expectedSequence: 2 },
    });
    expect(home.items().map((item) => item.title)).toEqual(['one']);
    await expect(submit(home, 2, { crid: 'x', title: 'x' }, 'replica:SOMEONE')).rejects.toThrow(
      'SHARED_DATASETS_INVALID',
    );
  });

  it('joining as a replica carries local items over once, even when sync is switched off and on again', async () => {
    const { d, world } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'h1', title: 'home note' });
    await d('R').write({ crid: 'r1', title: 'replica note' });
    world.now += 20_000;

    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    expect(d('H').items().map((item) => item.title)).toEqual(['home note', 'replica note']);
    expect(d('R').items()).toEqual(d('H').items());

    await d('R').engine.disable('notes');
    expect(await d('R').engine.getRole('notes')).toBe('off');
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    expect(d('H').items()).toHaveLength(2);
    expect(d('R').items()).toEqual(d('H').items());
  });

  it('queues edits while the home is offline and flushes them in order with rewritten ids and revisions', async () => {
    const { d, world, runTimers } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'x', title: 'x1' });
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    const x = d('R').items()[0];

    world.online.delete('H');
    const created = await d('R').engine.enqueueReplicaUpdate('notes', { crid: 'n1', title: 'new' });
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 1, title: 'x2' });
    // The optimistic revision (2) is not the home's: the engine chains the home's returned revision.
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 2, title: 'x3' });
    await d('R').engine.enqueueReplicaUpdate('notes', { id: created.id, expectedRevision: 1, title: 'new2' });
    expect(await d('R').engine.getSyncStatus('notes')).toMatchObject({
      role: 'replica',
      pending: 4,
      homeOnline: false,
    });
    expect(d('R').items().map((item) => item.title)).toEqual(['new2', 'x3']);
    await expect(d('R').engine.syncNow('notes')).rejects.toThrow();
    expect((await d('R').engine.getSyncStatus('notes')).pending).toBe(4);

    world.online.add('H');
    await d('R').engine.syncNow('notes');
    expect(d('H').items().map((item) => [item.title, item.revision])).toEqual([
      ['new2', 2],
      ['x3', 3],
    ]);
    expect(d('R').items()).toEqual(d('H').items());
    expect(await d('R').engine.getSyncStatus('notes')).toMatchObject({ pending: 0, conflicts: 0 });

    await runTimers(PUSH_DEBOUNCE_MS);
    await vi.waitFor(() =>
      expect(world.pushes.some((push) => push.to === 'R' && push.frame.dataset === 'notes')).toBe(true),
    );
  });

  // Agent / phone writes on a replica report the home's revision when the flush lands inside the bounded wait.
  it('a replica write waits briefly for its own flush: synced with the home revision, else pending', async () => {
    const { d, world, runTimers } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'x', title: 'x1' });
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    const x = d('R').items()[0];

    const waiting = d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 1, title: 'x2' }, { waitMs: 3000 });
    await vi.waitFor(async () => expect((await d('R').engine.getSyncStatus('notes')).pending).toBe(1), { timeout: 15_000 });
    await d('R').engine.syncNow('notes');
    expect(await waiting).toMatchObject({ synced: { id: x.id, revision: 2 } });

    world.online.delete('H');
    const offline = d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 2, title: 'x3' }, { waitMs: 3000 });
    await vi.waitFor(() => expect(world.timers.some((t) => t.live && t.delay === 3000)).toBe(true), { timeout: 15_000 });
    await runTimers(3000);
    expect((await offline).synced).toBeUndefined();
    expect((await d('R').engine.getSyncStatus('notes')).pending).toBe(1);
  });

  it('records a stale edit as a conflict beside the home version and resolves it either way', async () => {
    const { d } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'x', title: 'x' });
    await d('H').write({ crid: 'y', title: 'y' });
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    const [x, y] = d('R').items();
    await d('H').write({ id: x.id, expectedRevision: 1, title: 'x-home' });
    await d('H').write({ id: y.id, expectedRevision: 1, title: 'y-home' });
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 1, title: 'x-mine' });
    await d('R').engine.enqueueReplicaUpdate('notes', { id: y.id, expectedRevision: 1, title: 'y-mine' });

    await d('R').engine.syncNow('notes');
    const conflicts = await d('R').engine.listConflicts('notes');
    expect(conflicts.map((c) => [c.code, (c.homeItem as Note).title])).toEqual([
      ['STALE', 'x-home'],
      ['STALE', 'y-home'],
    ]);
    // The home's version is what the user sees until they choose.
    expect(d('R').items().map((item) => item.title)).toEqual(['x-home', 'y-home']);

    await d('R').engine.resolveConflict('notes', conflicts[0].id, 'mine');
    await d('R').engine.resolveConflict('notes', conflicts[1].id, 'theirs');
    await d('R').engine.syncNow('notes');
    expect(d('H').items().map((item) => [item.title, item.revision])).toEqual([
      ['x-mine', 3],
      ['y-home', 2],
    ]);
    expect(d('R').items()).toEqual(d('H').items());
    expect(await d('R').engine.getSyncStatus('notes')).toMatchObject({ pending: 0, conflicts: 0 });
  });

  it('set-as-home hands over, the old home becomes a replica and other replicas follow the new epoch', async () => {
    const { d, world } = createWorld(['A', 'B', 'C']);
    await d('A').engine.enable('notes');
    await d('A').write({ crid: 'x', title: 'x' });
    world.now += 20_000;
    for (const id of ['B', 'C']) {
      await d(id).engine.enable('notes');
      await d(id).engine.syncNow('notes');
    }

    await d('B').engine.setAsHome('notes');
    expect(await d('B').engine.getSyncStatus('notes')).toMatchObject({ role: 'home', homeDeviceId: 'B' });
    expect(await d('A').engine.getSyncStatus('notes')).toMatchObject({ role: 'replica', homeDeviceId: 'B' });

    world.now += 20_000;
    await d('B').write({ crid: 'after', title: 'after takeover' });
    await d('C').engine.syncNow('notes'); // A answers "not home" → C finds B
    await d('C').engine.syncNow('notes');
    expect(await d('C').engine.getSyncStatus('notes')).toMatchObject({ role: 'replica', homeDeviceId: 'B' });
    expect(d('C').items()).toEqual(d('B').items());
    expect(d('C').items().map((item) => item.title)).toContain('after takeover');
  });

  it('a stale home that was offline during the takeover stands down and carries its newer edits over', async () => {
    const { d, world } = createWorld(['A', 'B']);
    await d('A').engine.enable('notes');
    await d('A').write({ crid: 'y', title: 'y' });
    world.now += 20_000;
    await d('B').engine.enable('notes');
    await d('B').engine.syncNow('notes');

    world.online.delete('A');
    await d('B').engine.setAsHome('notes');
    expect(await d('B').engine.getSyncStatus('notes')).toMatchObject({ role: 'home' });
    const y = d('A').items()[0];
    await d('A').write({ id: y.id, expectedRevision: y.revision, title: 'y-edited-on-old-home' });

    world.online.add('A');
    world.now += 20_000;
    await d('A').engine.reconcile('notes');
    expect(await d('A').engine.getRole('notes')).toBe('replica');
    await d('A').engine.syncNow('notes');
    expect(d('B').items().map((item) => item.title)).toEqual(['y-edited-on-old-home']);
    expect(d('A').items()).toEqual(d('B').items());
    expect((await d('A').engine.getSyncStatus('notes')).conflicts).toBe(0);
  });

  it('an account switch during a sync discards the reply and leaves both accounts untouched', async () => {
    const { d, world } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    await d('R').engine.enqueueReplicaUpdate('notes', { crid: 'n', title: 'queued' });

    world.beforeInvoke = (_to, request) => {
      if (request.action === 'submit') world.owners.R = 'o2';
    };
    await expect(d('R').engine.syncNow('notes')).rejects.toThrow();
    world.beforeInvoke = undefined;

    // The other account sees a plain local dataset and cannot write into the first one's queue.
    expect(await d('R').engine.getSyncStatus('notes')).toMatchObject({ role: 'off', pending: 0 });
    await expect(
      d('R').engine.enqueueReplicaUpdate('notes', { crid: 'z', title: 'z' }),
    ).rejects.toMatchObject({ code: 'NOT_REPLICA' });
    expect(d('R').items()).toEqual([]);

    // Back on the first account the op was never dequeued; the home answers the retry from its receipt.
    world.owners.R = 'o1';
    expect((await d('R').engine.getSyncStatus('notes')).pending).toBe(1);
    await d('R').engine.syncNow('notes');
    expect(d('H').applied).toBe(1);
    expect(d('R').items()).toEqual(d('H').items());
  });

  it('refused edits keep distinct ids when the home restarts its epoch and sequences are renumbered', async () => {
    const { d } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'x', title: 'x' });
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    const x = d('R').items()[0];
    await d('H').write({ id: x.id, expectedRevision: 1, title: 'x-home' });
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 1, title: 'first' });
    await d('R').engine.syncNow('notes');
    expect(await d('R').engine.listConflicts('notes')).toHaveLength(1);

    // A fresh epoch forgets receipts: the replica's next op is renumbered back to sequence 1.
    await d('H').engine.disable('notes');
    await d('H').engine.enable('notes');
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 2, title: 'second' });
    await d('H').write({ id: x.id, expectedRevision: 2, title: 'x-home-2' });
    await d('R').engine.syncNow('notes');
    const conflicts = await d('R').engine.listConflicts('notes');
    expect(conflicts).toHaveLength(2);
    expect(new Set(conflicts.map((c) => c.id)).size).toBe(2);
  });

  it('a refused edit also parks the later queued edits of that item and never overwrites a newer home revision', async () => {
    const { d, world } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'x', title: 'x' });
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    const x = d('R').items()[0];
    world.online.delete('H');
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 1, title: 'op1' });
    // The mirror shows revision 2 now; that optimistic number must not become op2's base on the home.
    await d('R').engine.enqueueReplicaUpdate('notes', { id: x.id, expectedRevision: 2, title: 'op2' });
    await d('H').write({ id: x.id, expectedRevision: 1, title: 'x-home' }); // home revision is now 2
    world.online.add('H');
    await d('R').engine.syncNow('notes');
    expect(d('H').items().map((item) => [item.title, item.revision])).toEqual([['x-home', 2]]);
    expect((await d('R').engine.listConflicts('notes')).map((c) => c.update.title)).toEqual(['op1', 'op2']);
    expect(await d('R').engine.getSyncStatus('notes')).toMatchObject({ pending: 0, conflicts: 2 });
  });

  it('a receipt answers a retry of the same op only; an edit without a base revision is refused', async () => {
    const { d } = createWorld(['H', 'R']);
    const home = d('H');
    await home.engine.enable('notes');
    const request = (opId: string) => ({ action: 'submit', dataset: 'notes', source: 'replica:R', sequence: 1, opId, update: { crid: 'a', title: 'one' } });
    const first = await home.engine.handleRequest('R', request('op-a'));
    expect(await home.engine.handleRequest('R', request('op-a'))).toEqual(first);
    expect(await home.engine.handleRequest('R', request('op-b'))).toEqual({ error: { code: 'OUT_OF_ORDER', expectedSequence: 2 } });
    const item = home.items()[0];
    const noBase = { action: 'submit', dataset: 'notes', source: 'replica:R', sequence: 2, opId: 'op-c', update: { id: item.id, title: 'no base' } };
    expect(await home.engine.handleRequest('R', noBase)).toMatchObject({ error: { code: 'INVALID_PARAMS' } });
    expect(home.items()[0].title).toBe('one');
  });

  it('joining records a conflict for an item with the same revision but different content; a home runs the local write', async () => {
    const { d } = createWorld(['H', 'R']);
    await d('H').engine.enable('notes');
    await d('H').write({ crid: 'x', title: 'x' });
    const homeItem = d('H').items()[0];
    d('R').seed({ ...homeItem, title: 'restored copy' });
    await d('R').engine.enable('notes');
    expect((await d('R').engine.listConflicts('notes')).map((c) => [c.code, c.update.title])).toEqual([['DIVERGED', 'restored copy']]);

    let ran = 0;
    const out = await d('H').engine.writeDataset('notes', { crid: 'y', title: 'y' }, { localWrite: async () => ++ran });
    expect(out).toEqual({ local: true, value: 1 });
  });

  it('changed pushes go only to computers known to follow this home', async () => {
    const { d, world, runTimers } = createWorld(['H', 'R', 'X']);
    await d('H').engine.enable('notes');
    await d('R').engine.enable('notes');
    await d('R').engine.syncNow('notes');
    await d('R').engine.enqueueReplicaUpdate('notes', { crid: 'n', title: 'n' });
    await d('R').engine.syncNow('notes');
    await runTimers(PUSH_DEBOUNCE_MS);
    await vi.waitFor(() => expect(world.pushes.length).toBeGreaterThan(0));
    expect([...new Set(world.pushes.map((push) => push.to))]).toEqual(['R']);
  });
});

