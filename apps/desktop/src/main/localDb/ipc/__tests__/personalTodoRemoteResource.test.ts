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
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const env = vi.hoisted(() => ({
  dir: '',
  owner: 'a',
  stampOwner: 'a',
  tap: vi.fn(),
  catalog: [] as Array<Record<string, unknown>>,
  catalogFails: false,
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
