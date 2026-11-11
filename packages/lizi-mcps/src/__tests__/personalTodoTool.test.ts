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
});
