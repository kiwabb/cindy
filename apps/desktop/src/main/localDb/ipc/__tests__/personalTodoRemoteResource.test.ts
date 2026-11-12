/**
 * 测试价值
 * - 生产入口与可观察结果：手机经 remote-resources get/invoke 读写个人待办（真实 registry + 真实个人待办文件）。
 * - Bug／规则依据：docs/dev-rules/remote-and-mobile-adaptation.md「模块通过 Remote Resource 接入移动端」；
 *   资源响应只投影用户可见字段；写入后桌面 UI / Agent / 手机任一入口都要让手机重读；换账号不返回、不写入。
 * - 现有覆盖缺口：新资源；personalTodoIpc 明确拒绝 device-link。
 * - 最小失败输入：带 creationRequestId 的新建与过期 revision 的更新；账号在写入过程中切换。
 * - tier：unit（真实 registry 与待办文件，electron / 账号边界用内存替身）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const env = vi.hoisted(() => ({
  dir: '',
  owner: 'a',
  stampOwner: 'a',
  tap: vi.fn(),
  catalog: [] as Array<Record<string, unknown>>,
  catalogFails: false,
  role: 'off' as 'off' | 'home' | 'replica',
  homeCatalog: [] as Array<Record<string, unknown>>,
  enqueue: vi.fn(),
}));
vi.mock('../../../shared-datasets/api.js', () => ({
  getSharedDatasetRole: async () => env.role,
  getSharedDatasetExtras: async () => env.homeCatalog,
  // The real one decides the role under the engine's lock; here the role is the test's switch.
  writeSharedDataset: async (dataset: string, update: unknown, options: { localWrite: () => Promise<unknown>; waitMs?: number }) =>
    env.role === 'replica'
      ? { local: false, result: await env.enqueue(dataset, update, { waitMs: options.waitMs }) }
      : { local: true, value: await options.localWrite() },
  getSyncStatus: async () => ({ role: env.role, homeOnline: true, pending: 0, conflicts: 0 }),
}));
vi.mock('../taskTags.js', () => ({
  executeTaskTags: async () => {
    if (env.catalogFails) throw new Error('catalog unavailable');
    return { tags: env.catalog };
  },
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => env.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => env.dir,
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerStamp: { owner: env.owner }, owner: env.owner }),
  isDataOwnerBroadcastScopeCurrent: (scope: { owner: string }) => scope.owner === env.owner,
  tapWindowBroadcast: env.tap,
}));

import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry';
import { openPersonalTodoStore } from '../../../maker-ipc/personalTodoAccess';
import { personalTodosDataset } from '../../../maker-ipc/personalTodoSharedDataset';
import { registerPersonalTodoRemoteResource } from '../personalTodoRemoteResource';
import { emitTaskTagCatalogChanged } from '../taskTagChanges';

const context = { controllerDeviceId: 'phone' };
const client = { protocolVersion: 1, primitives: ['personal-todos'], locale: 'zh-CN' };
const ref = { collectionId: 'personal-todos', kind: 'personal-todos', id: 'todos:me' };
type Item = Record<string, unknown> & { id: string; revision: number };
const read = async () =>
  (await remoteResourceRegistry.get(context, { client, ref })).blocks![0].data as {
    items: Item[];
    total: number;
  };
const update = (input: Record<string, unknown>) =>
  remoteResourceRegistry.invoke(context, {
    client,
    collectionId: 'personal-todos',
    resourceRef: ref,
    actionId: 'update',
    input,
  });

beforeEach(async () => {
  env.owner = 'a';
  env.tap.mockReset();
  env.catalogFails = false;
  env.role = 'off';
  env.homeCatalog = [];
  env.enqueue.mockReset();
  env.catalog = [
    { id: 'preset:work', name: 'Work', color: 'indigo', favoriteOrder: null, revision: 1 },
    { id: 'tag-1', name: '客户', color: 'red', nameCustomized: true, favoriteOrder: null, revision: 1 },
  ];
  env.dir = await mkdtemp(path.join(os.tmpdir(), 'personal-todo-remote-'));
  registerPersonalTodoRemoteResource();
});
afterEach(async () => rm(env.dir, { recursive: true, force: true }));

it('projects only the allowlisted fields and round-trips an update with a changed push', async () => {
  const created = (await update({
    creationRequestId: 'req-1',
    title: '交报告',
    notes: '周五前',
    deadline: { kind: 'date', date: '2026-12-01', timeZone: 'Asia/Shanghai' },
  })) as { result: { todo: Item } };
  expect(env.tap).toHaveBeenCalledTimes(1);
  expect(env.tap.mock.calls[0][0]).toBe('maker:remote-resources:changed');
  expect(env.tap.mock.calls[0][1]).toMatchObject({ collectionId: 'personal-todos' });

  const { items, total } = await read();
  expect(total).toBe(1);
  expect(Object.keys(items[0]).sort()).toEqual(
    [
      'completedAt', 'createdAt', 'deadline', 'deferredUntil', 'id', 'notes', 'priority',
      'reminder', 'revision', 'status', 'subtasks', 'tags', 'title', 'updatedAt',
    ].sort(),
  );
  expect(items[0]).toMatchObject({ title: '交报告', notes: '周五前', status: 'open' });
  expect(created.result.todo.id).toBe(items[0].id);

  await update({ id: items[0].id, expectedRevision: items[0].revision, operation: 'complete' });
  expect((await read()).items[0].status).toBe('done');
  expect(env.tap).toHaveBeenCalledTimes(2);

  // A stale revision is a conflict the phone can reload from, and does not broadcast.
  await expect(
    update({ id: items[0].id, expectedRevision: items[0].revision, title: '旧修订' }),
  ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  await expect(update({ id: items[0].id, title: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(update({ id: items[0].id, secret: 'x' })).rejects.toMatchObject({
    code: 'INVALID_PARAMS',
  });
  expect(env.tap).toHaveBeenCalledTimes(2);
});

it('does not serve clients without the primitive and rejects after an account change', async () => {
  await expect(
    remoteResourceRegistry.get(context, { client: { ...client, primitives: [] }, ref }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });

  // The account switches after the request opened its store: nothing is returned.
  env.owner = 'a';
  const pending = remoteResourceRegistry.get(context, { client, ref });
  env.owner = 'b';
  await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });

  env.owner = 'a';
  const writing = update({ creationRequestId: 'req-2', title: 'x' });
  env.owner = 'b';
  await expect(writing).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(env.tap).not.toHaveBeenCalled();
});

it('projects priority, reminder and catalog-resolved tags, and advertises the organize marker', async () => {
  await update({ creationRequestId: 'req-3', title: '整理客户资料' });
  const { id, revision } = (await read()).items[0];
  const edited = (await update({
    id,
    expectedRevision: revision,
    priority: 3,
    reminder: 'before-1h',
    tagIds: ['tag-1', 'gone-tag', 'preset:work'],
  })) as { result: { todo: Item } };
  expect(edited.result.todo).toMatchObject({ priority: 3, reminder: 'before-1h' });

  const data = (await remoteResourceRegistry.get(context, { client, ref })).blocks![0].data as {
    items: Item[];
    capabilities: unknown;
  };
  expect(data.capabilities).toEqual({ organize: 1, subtasks: 1 });
  expect(data.items[0]).toMatchObject({ priority: 3, reminder: 'before-1h' });
  // Unknown ids are dropped, order kept, nameCustomized only when true, tagIds never on the wire.
  expect(data.items[0].tags).toEqual([
    { id: 'tag-1', name: '客户', color: 'red', nameCustomized: true },
    { id: 'preset:work', name: 'Work', color: 'indigo' },
  ]);
  expect(data.items[0]).not.toHaveProperty('tagIds');

  await expect(update({ id, priority: 9 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(update({ id, reminder: 'soon' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(update({ id, tagIds: [1] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

it('still serves the list with no tags when the tag catalog cannot be read', async () => {
  await update({ creationRequestId: 'req-4', title: 'x', tagIds: ['tag-1'] });
  env.catalogFails = true;
  const { items } = await read();
  expect(items).toHaveLength(1);
  expect(items[0].tags).toEqual([]);
});

// Rows carry resolved tag names, so a catalog rename must reach controllers: new revision + changed push.
it('treats a tag catalog change as a new revision and pushes a change for the todo list', async () => {
  await update({ creationRequestId: 'req-5', title: '标签改名', tagIds: ['tag-1'] });
  const before = (await remoteResourceRegistry.get(context, { client, ref })).revision;
  env.catalog = env.catalog.map((tag) => (tag.id === 'tag-1' ? { ...tag, name: '大客户' } : tag));
  env.tap.mockReset();
  emitTaskTagCatalogChanged({ ownerStamp: { owner: env.owner }, owner: env.owner } as never);
  expect(env.tap).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ collectionId: 'personal-todos' }),
    expect.anything(),
  );
  const after = await remoteResourceRegistry.get(context, { client, ref });
  expect(after.revision).not.toBe(before);
  expect((after.blocks![0].data as { items: Item[] }).items[0].tags).toEqual([
    { id: 'tag-1', name: '大客户', color: 'red', nameCustomized: true },
  ]);
});

it('projects subtasks, advertises the subtasks marker and round-trips a whole-list replace', async () => {
  await update({ creationRequestId: 'req-sub', title: '办活动', subtasks: [{ title: '订场地' }, { title: '发通知', done: true }] });
  let { items } = await read();
  const steps = items[0].subtasks as Array<{ id: string; title: string; done: boolean }>;
  expect(steps.map((s) => [s.title, s.done])).toEqual([['订场地', false], ['发通知', true]]);
  expect(Object.keys(steps[0]).sort()).toEqual(['done', 'id', 'title']);
  const data = (await remoteResourceRegistry.get(context, { client, ref })).blocks![0].data as { capabilities: unknown };
  expect(data.capabilities).toMatchObject({ subtasks: 1 });

  const before = await remoteResourceRegistry.get(context, { client, ref });
  await update({
    id: items[0].id,
    expectedRevision: items[0].revision,
    subtasks: [{ id: steps[0].id, title: '订场地', done: true }, { title: '买饮料' }],
  });
  items = (await read()).items;
  expect((items[0].subtasks as Array<{ title: string; done: boolean }>).map((s) => [s.title, s.done])).toEqual([['订场地', true], ['买饮料', false]]);
  expect((await remoteResourceRegistry.get(context, { client, ref })).revision).not.toBe(before.revision);
  await expect(update({ id: items[0].id, subtasks: 'x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(update({ id: items[0].id, subtasks: [{ title: 1 }] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

// 多台电脑同步（docs/shared-datasets-plan.md §5.3）：副本只有主力电脑一个写入者，手机经副本写入进待发队列；标签按主力电脑的目录解析。
it('on a replica queues the phone write for the main computer instead of writing the account file', async () => {
  env.role = 'replica';
  env.homeCatalog = [{ id: 'home-tag', name: '主力标签', color: 'green', favoriteOrder: null, revision: 1 }];
  env.enqueue.mockImplementation(async (_dataset: string, input: Record<string, unknown>) => ({
    id: 'todo:local',
    revision: 1,
    title: input.title,
    notes: '',
    deadline: null,
    status: 'open',
    deferredUntil: null,
    createdAt: 'x',
    updatedAt: 'x',
    priority: 0,
    tagIds: ['home-tag'],
    reminder: 'default',
  }));
  const written = (await update({ creationRequestId: 'req-6', title: '副本新建', tagIds: ['home-tag'] })) as {
    result: { todo: Item };
  };
  expect(env.enqueue).toHaveBeenCalledWith('personal-todos', expect.objectContaining({ creationRequestId: 'req-6' }), { waitMs: 3000 });
  // The local file is the mirror: nothing is written to it by this call, and no change is announced here.
  expect((await read()).total).toBe(0);
  expect(env.tap).not.toHaveBeenCalled();
  expect(written.result.todo).toMatchObject({ title: '副本新建', tags: [{ id: 'home-tag', name: '主力标签' }] });
  expect(env.catalog.some((tag) => tag.id === 'home-tag')).toBe(false);
});

// 步骤完成时间（docs/product-rules/personal-todos.md）：副本上勾的步骤进待发队列时就带上勾选时间，
// 主力电脑稍后补交时记下的是这个时间，不是补交时间；已勾的步骤保留原来的时间。
it('on a replica queues a checked step with the moment it was checked, which the home keeps on a later flush', async () => {
  await update({ creationRequestId: 'req-timed', title: '副本勾步骤', subtasks: [{ title: '一步', done: true }, { title: '二步' }] });
  const before = (await read()).items[0];
  const steps = before.subtasks as Array<{ id: string; title: string; done: boolean }>;
  const firstDoneAt = (await openPersonalTodoStore().store.list())[0].subtasks[0].doneAt;
  // The home's file as it was before the replica edit; the replica's own file is its mirror.
  const home = await mkdtemp(path.join(os.tmpdir(), 'personal-todo-home-'));
  await copyFile(path.join(env.dir, 'personal-todos.v1.json'), path.join(home, 'personal-todos.v1.json'));
  env.role = 'replica';
  // Like the engine: queue the edit as given, then apply that same edit to the mirror.
  env.enqueue.mockImplementation(async (_dataset: string, queued: Record<string, unknown>) => personalTodosDataset.applySubmit(queued));
  const editedFrom = new Date().toISOString();
  await update({ id: before.id, expectedRevision: before.revision, subtasks: steps.map((s) => ({ id: s.id, title: s.title, done: true })) });
  // The phone sends no times; the queued edit carries them (the earlier step keeps its own).
  const queued = env.enqueue.mock.calls[0][1] as { subtasks: Array<{ doneAt?: string }> };
  expect(queued.subtasks[0].doneAt).toBe(firstDoneAt);
  expect(queued.subtasks[1].doneAt! >= editedFrom).toBe(true);
  const mirror = (await openPersonalTodoStore().store.list())[0];
  expect(mirror.subtasks.map((s) => s.doneAt)).toEqual(queued.subtasks.map((s) => s.doneAt));
  // The main computer applies the queued edit later and records the same moments.
  const replicaDir = env.dir;
  env.dir = home;
  const applied = (await personalTodosDataset.applySubmit(queued)) as unknown as { subtasks: Array<{ doneAt?: string }> };
  expect(applied.subtasks.map((s) => s.doneAt)).toEqual(queued.subtasks.map((s) => s.doneAt));
  env.dir = replicaDir;
  await rm(home, { recursive: true, force: true });
});

// 加入同步/降级时带过去的待办：已完成保持完成、稍后保持稍后（不重开）、已删除不带（docs/product-rules/personal-todos.md「多台电脑同步」）。
it('carries completed and deferred todos over faithfully and skips deleted ones', async () => {
  const later = new Date(Date.now() + 86_400_000).toISOString();
  await update({ creationRequestId: 'c-open', title: '进行中', subtasks: [{ title: '一步' }, { title: '二步', done: true }] });
  await update({ creationRequestId: 'c-done', title: '已完成' });
  await update({ creationRequestId: 'c-later', title: '稍后' });
  await update({ creationRequestId: 'c-gone', title: '已删除' });
  const byTitle = async (title: string) => (await read()).items.find((item) => item.title === title)!;
  const op = async (title: string, input: Record<string, unknown>) => {
    const item = await byTitle(title);
    await update({ id: item.id, expectedRevision: item.revision, ...input });
  };
  await op('已完成', { operation: 'complete' });
  await op('稍后', { operation: 'later', until: later });
  await op('已删除', { operation: 'delete' });

  const raw = await personalTodosDataset.readItems();
  const carried = raw.map((item, index) => personalTodosDataset.creationUpdate(item, `import-x-${index}`));
  expect(carried.filter(Boolean)).toHaveLength(3);

  // Replay onto a fresh account file (the other computer's home).
  env.dir = await mkdtemp(path.join(os.tmpdir(), 'personal-todo-carry-'));
  for (const creation of carried) if (creation) await personalTodosDataset.applySubmit(creation);
  const { store } = openPersonalTodoStore();
  const after = new Map((await store.list()).map((todo) => [todo.title, todo]));
  expect([...after.keys()].sort()).toEqual(['已完成', '稍后', '进行中']);
  expect(after.get('已完成')?.status).toBe('done');
  expect(after.get('稍后')).toMatchObject({ status: 'open', deferredUntil: later });
  expect(after.get('进行中')).toMatchObject({ status: 'open', deferredUntil: null });
  expect(after.get('进行中')?.subtasks.map((s) => [s.title, s.done])).toEqual([['一步', false], ['二步', true]]);
  // The step keeps the moment it was checked on the computer it came from.
  expect(after.get('进行中')?.subtasks[1].doneAt).toBe(raw.find((r) => r.title === '进行中')!.subtasks![1].doneAt);
  const home = personalTodosDataset.reviseUpdate!(raw.find((r) => r.title === '进行中')!, raw.find((r) => r.title === '进行中')!);
  expect((home as { subtasks: unknown[] }).subtasks).toHaveLength(2);
  // The same creation again (a retried flush) changes nothing.
  for (const creation of carried) if (creation) await personalTodosDataset.applySubmit(creation);
  expect(await store.list()).toHaveLength(3);
  await rm(env.dir, { recursive: true, force: true });
});
