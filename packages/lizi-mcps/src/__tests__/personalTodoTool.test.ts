import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerPersonalTodoTools, type PersonalTodoCallbacks } from '../xdt-helper/personal_todo.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

/**
 * 测试价值
 * - 生产入口:registerPersonalTodoTools 经 registry.call 给模型的 JSON。
 * - 规则:个人待办是用户本人的清单(仅本机、当前账号);新建靠 creationRequestId 幂等,
 *   版本冲突必须告诉 Agent 先重新列出再重试,而不是静默覆盖或只给一个错误码。
 * - 最小失败输入:新建带 creationRequestId;同一 id 重试遇到 CONFLICT;缺少 creationRequestId 的非法 id 格式;
 *   稍后中的待办不应出现在默认列表之外的 open 视图。
 * - tier:unit(宿主回调 mock)。
 */
describe('personal todo tools', () => {
  it('forwards a create with its creationRequestId and tells the model how to recover from a conflict', async () => {
    const callback = vi.fn<PersonalTodoCallbacks>(async (operation) =>
      operation === 'update'
        ? { ok: false as const, errorCode: 'CONFLICT', message: 'CONFLICT' }
        : { ok: true as const, items: [] },
    );
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, callback);
    const create = { title: '交周报', creationRequestId: 'req_1', deadline: { kind: 'date', date: '2026-11-12', timeZone: 'Asia/Shanghai' } };
    const result = parse(await reg.call('update_personal_todo', create));
    expect(callback).toHaveBeenCalledWith('update', create);
    expect(result).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect(JSON.stringify(result)).toContain('list_personal_todos');
    expect(parse(await reg.call('update_personal_todo', { title: 'x', creationRequestId: 'bad id!' })).ok).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps later todos out of the open view and labels the result as local', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const items = [
      { id: 'a', revision: 1, title: 'A', notes: '', deadline: null, status: 'open', deferredUntil: null },
      { id: 'b', revision: 1, title: 'B', notes: '', deadline: null, status: 'open', deferredUntil: future },
      { id: 'c', revision: 2, title: 'C', notes: '', deadline: null, status: 'done', deferredUntil: null },
    ];
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, async () => ({ ok: true as const, items }));
    const ids = async (view?: string) =>
      (parse(await reg.call('list_personal_todos', view ? { view } : {})).items as Array<{ id: string }>).map((t) => t.id);
    expect(await ids()).toEqual(['a', 'b']);
    expect(await ids('open')).toEqual(['a']);
    expect(await ids('later')).toEqual(['b']);
    expect(await ids('done')).toEqual(['c']);
    expect(await ids('all')).toEqual(['a', 'b', 'c']);
    expect(parse(await reg.call('list_personal_todos', {}))).toMatchObject({ scope: 'local-current-account' });
  });

  // 多台电脑同步(docs/product-rules/personal-todos.md):副本上的写入是「待主力电脑接收」,不是失败,Agent 必须能读到。
  it('passes the multi-computer sync summary and a replica write receipt through to the model', async () => {
    const sync = { role: 'replica', homeName: 'Desk', homeOnline: false, pending: 2, conflicts: 0 };
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, async (operation) =>
      operation === 'update'
        ? { ok: true as const, todo: { id: 'a', revision: 2 }, sync: 'pending' }
        : { ok: true as const, items: [], sync },
    );
    expect(parse(await reg.call('list_personal_todos', {}))).toMatchObject({ sync });
    expect(parse(await reg.call('update_personal_todo', { id: 'a', expectedRevision: 1, title: 'x' }))).toMatchObject({
      ok: true,
      sync: 'pending',
    });
  });

  // 用户在待办页能做的同步管理(状态、开关、设为主力电脑、冲突)Agent 也要能做(agent-user-parity.md)。
  it('exposes the sync management the todo page has, only when the host provides it', async () => {
    const without = new XdtHelperToolRegistry();
    registerPersonalTodoTools(without, async () => ({ ok: true as const, items: [] }));
    expect((await without.call('get_personal_todo_sync', {})).isError).toBe(true);

    const sync = vi.fn(async () => ({ ok: true as const, status: { role: 'replica', pending: 0 } }));
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, async () => ({ ok: true as const, items: [] }), sync);
    await reg.call('get_personal_todo_sync', {});
    await reg.call('set_personal_todo_sync', { action: 'set_home' });
    await reg.call('set_personal_todo_sync', { action: 'enable' });
    await reg.call('resolve_personal_todo_conflict', { conflictId: 'c-3', choice: 'theirs' });
    expect(sync.mock.calls).toEqual([
      ['status', undefined],
      ['set-home', undefined],
      ['enable', undefined],
      ['resolve', { conflictId: 'c-3', choice: 'theirs' }],
    ]);
    expect((await reg.call('resolve_personal_todo_conflict', { conflictId: 'c-3', choice: 'x' })).isError).toBe(true);
  });

  it('forwards priority/tagIds/reminder and lists them with resolved tag names and the catalog', async () => {
    const items = [
      { id: 'a', revision: 1, title: 'A', notes: '', deadline: null, status: 'open', deferredUntil: null, priority: 3, tagIds: ['t1', 'gone'], reminder: 'before-1h' },
      { id: 'b', revision: 1, title: 'B', notes: '', deadline: null, status: 'open', deferredUntil: null },
    ];
    const tags = [{ id: 't1', name: '工作', color: 'blue', revision: 4 }];
    const callback = vi.fn<PersonalTodoCallbacks>(async (operation) =>
      operation === 'list' ? { ok: true as const, items, tags } : { ok: true as const, todo: items[0] },
    );
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, callback);
    const patch = { id: 'a', expectedRevision: 1, priority: 3, tagIds: ['t1'], reminder: 'before-1h' };
    expect(parse(await reg.call('update_personal_todo', patch)).ok).toBe(true);
    expect(callback).toHaveBeenCalledWith('update', patch);
    expect(parse(await reg.call('update_personal_todo', { id: 'a', priority: 4 })).ok).toBe(false);
    expect(parse(await reg.call('update_personal_todo', { id: 'a', reminder: 'soon' })).ok).toBe(false);
    const listed = parse(await reg.call('list_personal_todos', {}));
    expect(listed.tags).toEqual([{ id: 't1', name: '工作', color: 'blue' }]);
    expect(listed.items).toMatchObject([
      { id: 'a', priority: 3, tagIds: ['t1', 'gone'], reminder: 'before-1h', tags: [{ id: 't1', name: '工作', color: 'blue' }] },
      { id: 'b', priority: 0, tagIds: [], reminder: 'default', tags: [] },
    ]);
    const ids = async (filter: object) =>
      (parse(await reg.call('list_personal_todos', filter)).items as Array<{ id: string }>).map((t) => t.id);
    expect(await ids({ priority: 2 })).toEqual(['a']);
    expect(await ids({ tagId: 't1' })).toEqual(['a']);
    expect(await ids({ tagId: 'other' })).toEqual([]);
  });

  it('forwards a whole subtasks list and lists steps with progress', async () => {
    const steps = [{ id: 's1', title: '订会议室', done: true }, { id: 's2', title: '发通知', done: false }];
    const items = [
      { id: 'a', revision: 3, title: 'A', notes: '', deadline: null, status: 'open', deferredUntil: null, subtasks: steps },
      { id: 'b', revision: 1, title: 'B', notes: '', deadline: null, status: 'open', deferredUntil: null },
    ];
    const callback = vi.fn<PersonalTodoCallbacks>(async (operation) =>
      operation === 'list' ? { ok: true as const, items } : { ok: true as const, todo: items[0] },
    );
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, callback);
    const patch = { id: 'a', expectedRevision: 3, subtasks: [{ id: 's1', title: '订会议室', done: true }, { title: '新步骤' }] };
    expect(parse(await reg.call('update_personal_todo', patch)).ok).toBe(true);
    expect(callback).toHaveBeenCalledWith('update', patch);
    expect(parse(await reg.call('update_personal_todo', { id: 'a', subtasks: [{ title: '' }] })).ok).toBe(false);
    const listed = parse(await reg.call('list_personal_todos', {}));
    expect(listed.items).toMatchObject([
      { id: 'a', subtasks: steps, subtasksDone: 1, subtasksTotal: 2 },
      { id: 'b', subtasks: [], subtasksDone: 0, subtasksTotal: 0 },
    ]);
  });

  // The tutor links its study todos to a conversation (2026-11-13, fork): the link reaches the host
  // as given, null clears it, and a link with unknown fields never reaches the host.
  it('forwards a conversation link or its removal and rejects one with unknown fields', async () => {
    const callback = vi.fn<PersonalTodoCallbacks>(async () => ({ ok: true as const, todo: {} }));
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, callback);
    const link = { sessionId: '79f2beb7-c1cc-4425-a77e-f4103d13f71c', deviceId: 'dev-1', botId: 'bot_tutor' };
    expect(parse(await reg.call('update_personal_todo', { creationRequestId: 'study-1', title: '今日学习', link })).ok).toBe(true);
    expect(callback).toHaveBeenLastCalledWith('update', { creationRequestId: 'study-1', title: '今日学习', link });
    expect(parse(await reg.call('update_personal_todo', { id: 'a', expectedRevision: 1, link: null })).ok).toBe(true);
    expect(callback).toHaveBeenLastCalledWith('update', { id: 'a', expectedRevision: 1, link: null });
    callback.mockClear();
    expect(parse(await reg.call('update_personal_todo', { id: 'a', link: { sessionId: 's', path: '/x' } })).ok).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  // 手动排序交给伙伴（docs/product-rules/personal-todos.md「手动排序」）：列表默认按宿主给的手动顺序并带 position；
  // 单条移动与一批重排都把位置原样交给宿主；位置参数给了多个时不碰宿主，直接告诉模型只能三选一。
  it('lists in manual order with positions, sorts on request and forwards moves and batch reorders', async () => {
    const items = [
      { id: 'a', revision: 1, title: 'A', notes: '', deadline: null, status: 'open', deferredUntil: null, priority: 1, rank: 10 },
      { id: 'b', revision: 1, title: 'B', notes: '', deadline: null, status: 'done', deferredUntil: null, priority: 0, rank: 20 },
      { id: 'c', revision: 1, title: 'C', notes: '', deadline: { kind: 'date', date: '2026-11-20', timeZone: 'Asia/Shanghai' }, status: 'open', deferredUntil: null, priority: 3, rank: 30 },
    ];
    const callback = vi.fn<PersonalTodoCallbacks>(async (operation) =>
      operation === 'list' ? { ok: true as const, items } : { ok: true as const, todos: [] },
    );
    const reg = new XdtHelperToolRegistry();
    registerPersonalTodoTools(reg, callback);
    const listed = (await reg.call('list_personal_todos', {}).then(parse)).items as Array<Record<string, unknown>>;
    expect(listed.map((t) => [t.id, t.position])).toEqual([['a', 1], ['c', 3]]);
    expect(listed[0]).not.toHaveProperty('rank');
    const sorted = async (sort: string) =>
      ((await reg.call('list_personal_todos', { view: 'all', sort }).then(parse)).items as Array<{ id: string }>).map((t) => t.id);
    expect(await sorted('priority')).toEqual(['c', 'a', 'b']);
    expect(await sorted('due')).toEqual(['c', 'a', 'b']);

    await reg.call('update_personal_todo', { id: 'c', expectedRevision: 1, moveTo: 'top' });
    expect(callback).toHaveBeenLastCalledWith('update', { id: 'c', expectedRevision: 1, place: { to: 'top' } });
    await reg.call('update_personal_todo', { creationRequestId: 'n1', title: 'N', afterId: 'a' });
    expect(callback).toHaveBeenLastCalledWith('update', { creationRequestId: 'n1', title: 'N', place: { after: 'a' } });
    expect(parse(await reg.call('reorder_personal_todos', { ids: ['c', 'a'], beforeId: 'b' })).ok).toBe(true);
    expect(callback).toHaveBeenLastCalledWith('reorder', { ids: ['c', 'a'], place: { before: 'b' } });
    await reg.call('reorder_personal_todos', { ids: ['b', 'a', 'c'] });
    expect(callback).toHaveBeenLastCalledWith('reorder', { ids: ['b', 'a', 'c'] });

    callback.mockClear();
    const both = parse(await reg.call('reorder_personal_todos', { ids: ['a'], moveTo: 'top', afterId: 'b' }));
    expect(both).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(parse(await reg.call('update_personal_todo', { id: 'a', beforeId: 'b', afterId: 'c' })).ok).toBe(false);
    expect((await reg.call('reorder_personal_todos', { ids: [] })).isError).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });
});
