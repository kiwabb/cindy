// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：手机电脑页的个人待办入口与列表数据（usePersonalTodos + 分组 / 到期判据）。
 * - Bug／规则依据：docs/dev-rules/remote-and-mobile-adaptation.md「模块通过 Remote Resource 接入移动端」——
 *   未知 collection 不得崩溃、旧主机不显示入口；断线保留上次数据；写入冲突要重读最新。
 * - 现有覆盖缺口：新入口；companionGlance 只覆盖伙伴待办。
 * - 最小失败输入：不含 personal-todos 的 manifest；带过期 revision 的更新（ALREADY_EXISTS）；读取失败。
 * - tier：unit（jsdom 驱动真实 hook，device-link 用内存 fake）。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  collections: [] as Array<{ id: string; resourceKind: string }>,
  items: [] as unknown[],
  readFails: false,
  invokeError: null as unknown,
  reads: 0,
  invokes: [] as Array<Record<string, unknown>>,
}));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, accountGeneration: 1 }) }));
const link = vi.hoisted(() => ({ invoke: vi.fn(), openLink: async () => undefined, onRemoteResourceChanged: () => () => undefined }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => link }));
vi.mock('@/device-link/remoteResources', () => ({
  loadRemoteResourceManifest: async () => ({ protocolVersion: 1, collections: h.collections }),
  getRemoteResource: async () => {
    h.reads++;
    if (h.readFails) throw new Error('DEVICE_OFFLINE');
    return { blocks: [{ primitive: 'personal-todos', data: { items: h.items, total: h.items.length } }] };
  },
  invokeRemoteResourceAction: async (_i: unknown, _t: unknown, request: Record<string, unknown>) => {
    h.invokes.push(request);
    if (h.invokeError) throw h.invokeError;
    return { effects: [], result: { todo: h.items[0] } };
  },
}));

const { usePersonalTodos, groupPersonalTodos, personalTodoDue, personalTodoErrorKind } = await import('@/session/usePersonalTodos');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let latest: ReturnType<typeof usePersonalTodos>;
function Probe({ deviceId }: { deviceId: string }) {
  latest = usePersonalTodos({ deviceId, deviceName: 'PC', enabled: true });
  return null;
}
const mount = async (deviceId: string) => {
  await act(async () => root.render(createElement(Probe, { deviceId })));
  await act(async () => { await Promise.resolve(); });
};
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, revision: 1, title: id, notes: '', deadline: null, status: 'open', deferredUntil: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', completedAt: null, ...extra,
});
beforeEach(() => {
  h.collections = [{ id: 'personal-todos', resourceKind: 'personal-todos' }];
  h.items = []; h.readFails = false; h.invokeError = null; h.reads = 0; h.invokes = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

it('hides the entry for a host without the collection and never reads the resource', async () => {
  h.collections = [{ id: 'teammates', resourceKind: 'bot' }, { id: 'something-new', resourceKind: 'x' }];
  await mount('old-pc');
  expect(latest.available).toBe(false);
  expect(h.reads).toBe(0);
});

it('lists, groups and counts due items, writes with the revision, and keeps the last list when the host goes offline', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 86_400_000).toISOString();
  h.items = [
    item('due', { deadline: { kind: 'date', date: today, timeZone: 'UTC' } }),
    item('far', { deadline: { kind: 'date', date: '2999-01-01', timeZone: 'UTC' } }),
    item('snoozed', { deferredUntil: later, deadline: { kind: 'date', date: '2000-01-01', timeZone: 'UTC' } }),
    item('finished', { status: 'done', completedAt: '2026-11-02T00:00:00Z' }),
    { id: 'broken' },
  ];
  await mount('pc');
  expect(latest.available).toBe(true);
  expect(latest.items.map(i => i.id)).toEqual(['due', 'far', 'snoozed', 'finished']);
  const groups = groupPersonalTodos(latest.items);
  expect(groups.open.map(i => i.id)).toEqual(['due', 'far']);
  expect(groups.later.map(i => i.id)).toEqual(['snoozed']);
  expect(groups.done.map(i => i.id)).toEqual(['finished']);
  expect(latest.items.filter(i => personalTodoDue(i)).map(i => i.id)).toEqual(['due']);

  await act(async () => { await latest.update({ id: 'due', expectedRevision: 1, operation: 'complete' }); });
  expect(h.invokes[0]).toMatchObject({ collectionId: 'personal-todos', actionId: 'update', input: { id: 'due', expectedRevision: 1, operation: 'complete' } });

  // Offline: failed flag, same data; a remount of the page still shows the entry.
  h.readFails = true;
  await act(async () => { await latest.refresh(); });
  expect(latest.failed).toBe(true);
  expect(latest.items).toHaveLength(4);
  await act(async () => root.unmount());
  root = createRoot(document.createElement('div'));
  await mount('pc');
  expect(latest.available).toBe(true);
  expect(latest.items).toHaveLength(4);
});

it('re-reads the latest on a revision conflict and classifies the host error codes', async () => {
  h.items = [item('a')];
  await mount('pc2');
  const reads = h.reads;
  h.invokeError = Object.assign(new Error('CONFLICT'), { code: 'ALREADY_EXISTS' });
  await act(async () => {
    await expect(latest.update({ id: 'a', expectedRevision: 0, title: 'x' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });
  expect(h.reads).toBeGreaterThan(reads);
  expect(personalTodoErrorKind(h.invokeError)).toBe('conflict');
  expect(personalTodoErrorKind({ code: 'NOT_FOUND' })).toBe('gone');
  expect(personalTodoErrorKind(new Error('boom'))).toBe('failed');
});
