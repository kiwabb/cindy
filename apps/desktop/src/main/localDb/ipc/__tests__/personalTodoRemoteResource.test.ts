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

const env = vi.hoisted(() => ({ dir: '', owner: 'a', stampOwner: 'a', tap: vi.fn() }));
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
      'completedAt', 'createdAt', 'deadline', 'deferredUntil', 'id', 'notes',
      'revision', 'status', 'title', 'updatedAt',
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
