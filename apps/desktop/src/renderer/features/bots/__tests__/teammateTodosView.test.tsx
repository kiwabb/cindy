// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalTodoStore } from '../../../../main/maker-ipc/personalTodoStore';
import userEvent from '@testing-library/user-event';
import { personalBoardItems } from '../personalTodos';

/**
 * 测试价值
 * - 生产入口与可观察结果：「待办」页（TeammateTodosView，路由 /bots/todos）只列个人待办。主人看到的分段与顺序、
 *   稍后再说与已完成不混进进行中、新建／编辑／完成／重开／稍后再说／删除后落到看得见的位置、侧栏数与列表同步。
 * - Bug／规则依据：2026-11-06 主人确认的待办面板原型（单列表按截止分段）；上游移除伙伴待办后，
 *   本页只保留个人待办（个人事项不由伙伴 origin 字段推断）。
 * - 现有覆盖缺口：个人待办的存取与冲突恢复在主进程 store 测试里，页面的分段、落点与重试没有别的覆盖。
 * - 最小失败输入：每段各一条个人待办，外加一条稍后再说与一条已完成。
 * - tier：unit（jsdom 渲染真实页面，主进程 IPC 用内存 fake；恢复用例接真实 store 与临时目录）。
 */
import { refreshPersonalTodos, updatePersonalTodo, personalTodoCacheTesting } from '../personalTodoCache';
import { useTodoBoardOpenCount } from '../useTeammateTodoBoard';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ generation: 1 }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join('|')}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => h.generation }));

const { TeammateTodosView } = await import('../TeammateTodosView');

beforeEach(() => {
  // 2026-11-06 是周五；本周到 11-08 周日为止。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T02:30:00Z'));
  h.generation = 1;
  setDataOwnerGeneration('test-owner', 1);
  personalTodoCacheTesting.reset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { personalTodos: { list: vi.fn(async () => []), update: vi.fn() } },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const rowTitles = (root: HTMLElement = document.body) =>
  within(root).queryAllByTestId('todo-board-row').map((row) => row.querySelector('.truncate')?.textContent);

const base = { revision: 1, notes: '', status: 'open' as const, deferredUntil: null, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
const dated = (value: string) => ({ kind: 'date' as const, date: value, timeZone: 'UTC' });

describe('TeammateTodosView', () => {
  it('lists personal todos in deadline sections and keeps snoozed and done out of the open view', async () => {
    vi.mocked(window.electronAPI.localDb.personalTodos.list).mockResolvedValue([
      { ...base, id: 'p1', title: '交报销单', deadline: dated('2026-11-04') },
      { ...base, id: 'p2', title: '回复张雯', deadline: { kind: 'instant', date: '2026-11-06', timeZone: 'UTC', at: '2026-11-06T09:00:00Z' } },
      { ...base, id: 'p3', title: '审阅合并请求', deadline: dated('2026-11-08') },
      { ...base, id: 'p4', title: '升级 Electron', deadline: dated('2026-11-14') },
      { ...base, id: 'p5', title: '预约牙医', deadline: null },
      { ...base, id: 'p6', title: '换办公椅', deadline: null, deferredUntil: '2026-11-15T01:00:00Z' },
      { ...base, id: 'p7', title: '交 OKR 自评', deadline: null, status: 'done', completedAt: '2026-11-04T08:00:00Z' },
    ]);
    render(<TeammateTodosView />);
    await waitFor(() => expect(rowTitles()).toHaveLength(5));
    const sections = [...document.querySelectorAll('section')].map((section) => ({
      label: section.querySelector('h3')?.textContent,
      rows: rowTitles(section),
    }));
    expect(sections).toEqual([
      { label: 'bots.todoBoard.bucket.overdue', rows: ['交报销单'] },
      { label: 'bots.todoBoard.bucket.today', rows: ['回复张雯'] },
      { label: 'bots.todoBoard.bucket.week', rows: ['审阅合并请求'] },
      { label: 'bots.todoBoard.bucket.later', rows: ['升级 Electron'] },
      { label: 'bots.todoBoard.bucket.none', rows: ['预约牙医'] },
    ]);

    // 已完成折叠在底部。
    fireEvent.click(screen.getByText('bots.glance.doneCount:1'));
    expect(rowTitles()).toContain('交 OKR 自评');

    // 稍后再说单独一档，带再提醒的日期。
    fireEvent.click(screen.getByRole('radio', { name: 'bots.todoBoard.view.later' }));
    expect(rowTitles()).toEqual(['换办公椅']);
    expect(screen.getByText(/^bots.todoBoard.laterUntil:/)).toBeTruthy();
  });
});

// Existing page unit tier: fixture IPC only, no real account writes/model calls.
// New coverage: title-only manual form, rejection retaining input, successful retry,
// completion and reopening through rendered production handlers without a teammate.
it('supports personal creation without teammates and preserves input on a failed save', async () => {
    const update = vi.mocked(window.electronAPI.localDb.personalTodos.update);
  const item = { id: 'personal-1', revision: 1, title: 'Unit personal item', notes: '', deadline: null,
    status: 'open' as const, deferredUntil: null, createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  update.mockRejectedValueOnce(new Error('Disk failure')).mockResolvedValueOnce(item);
  render(<TeammateTodosView />);
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.add' }));
  fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value: item.title } });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('personalTodos.title') as HTMLInputElement).value).toBe(item.title);
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await waitFor(() => expect(rowTitles()).toEqual([item.title]));
  fireEvent.click(within(screen.getByTestId('todo-board-row')).getByRole('button', { name: item.title }));
  fireEvent.change(screen.getByLabelText('personalTodos.notes'), { target: { value: 'Edited notes' } });
  update.mockResolvedValueOnce({ ...item, revision: 2, notes: 'Edited notes' });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await waitFor(() => expect(screen.queryByLabelText('personalTodos.notes')).toBeNull());
  fireEvent.click(within(screen.getByTestId('todo-board-row')).getByRole('button', { name: item.title }));
  expect((screen.getByLabelText('personalTodos.notes') as HTMLTextAreaElement).value).toBe('Edited notes');
  update.mockResolvedValueOnce({ ...item, revision: 3, status: 'done' });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.complete' }));
  await waitFor(() => expect(rowTitles()).toEqual([]));
  fireEvent.click(screen.getByRole('button', { name: 'bots.glance.doneCount:1' }));
  fireEvent.click(within(screen.getByTestId('todo-board-row')).getByRole('button', { name: item.title }));
  update.mockResolvedValueOnce({ ...item, revision: 4 });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.reopen' }));
  await waitFor(() => expect(rowTitles()).toEqual([item.title]));
});

const openItem = { id: 'form-unit', revision: 1, title: 'Form unit', notes: '', deadline: null, status: 'open' as const,
  deferredUntil: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };

// Store contract (INVALID_PARAMS for past deferral; instant needs at on the local date): validated/built in the editor.
it('sends a time-of-day deadline as an instant and rejects a deferral that is not in the future before saving', async () => {
    const api = window.electronAPI.localDb.personalTodos;
  vi.mocked(api.list).mockResolvedValue([openItem]);
  render(<TeammateTodosView />);
  fireEvent.click(await screen.findByRole('button', { name: openItem.title }));
  fireEvent.change(screen.getByLabelText('personalTodos.deferUntil'), { target: { value: '2026-11-05T10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.defer' }));
  expect((await screen.findByRole('alert')).textContent).toBe('personalTodos.deferInPast');
  expect(api.update).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('personalTodos.deadline'), { target: { value: '2026-11-20' } });
  fireEvent.change(screen.getByLabelText('personalTodos.deadlineTime'), { target: { value: '09:30' } });
  vi.mocked(api.update).mockResolvedValueOnce({ ...openItem, revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.update).mock.lastCall?.[0].deadline).toEqual({
    kind: 'instant', date: '2026-11-20', at: new Date('2026-11-20T09:30').toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

function PersonalCount() { return <output data-testid="personal-count">{useTodoBoardOpenCount()}</output>; }
// Unit fixtures only: all creation entrances must land on a visible personal open row;
// the sidebar count shares one read and observes completion/reopening without polling.
it.each(['open', 'done', 'later'] as const)('reveals a new personal todo created from %s and shares inline updates with the badge', async entrance => {
    const item = { id: 'visible-unit', revision: 1, title: 'Visible unit todo', notes: '', deadline: null,
    status: 'open' as const, deferredUntil: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  const api = window.electronAPI.localDb.personalTodos;
  vi.mocked(api.update).mockResolvedValueOnce(item);
  render(<><PersonalCount /><TeammateTodosView /></>);
  await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('0'));
  if (entrance !== 'open') fireEvent.click(screen.getByRole('radio', { name: `bots.todoBoard.view.${entrance}` }));
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.add' }));
  fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value: item.title } });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await waitFor(() => expect(rowTitles()).toEqual([item.title]));
  expect(screen.getByTestId('personal-count').textContent).toBe('1');
  expect(screen.getByRole('radio', { name: 'bots.todoBoard.view.open' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getAllByRole('status').some(node => node.textContent?.includes('personalTodos.savedNotice'))).toBe(true);
  expect(api.list).toHaveBeenCalledTimes(1);
  vi.mocked(api.update).mockRejectedValueOnce(new Error('Unit write failed'));
  const toggle = screen.getByRole('checkbox', { name: `personalTodos.complete: ${item.title}` });
  toggle.focus();
  await userEvent.keyboard(' ');
  await screen.findByRole('alert');
  expect(screen.getByTestId('personal-count').textContent).toBe('1');
  vi.mocked(api.update).mockResolvedValueOnce({ ...item, revision: 2, status: 'done', completedAt: '2026-11-06T00:00:00Z' });
  fireEvent.click(screen.getByRole('checkbox', { name: `personalTodos.complete: ${item.title}` }));
  await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('0'));
  fireEvent.click(screen.getByRole('button', { name: 'bots.todoBoard.view.done' }));
  vi.mocked(api.update).mockResolvedValueOnce({ ...item, revision: 3 });
  fireEvent.click(screen.getByRole('checkbox', { name: `personalTodos.reopen: ${item.title}` }));
  await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('1'));
  expect(rowTitles()).toEqual([item.title]);
});

// Unit cache lifecycle: one mounted badge observes local mutations and the real deadline timer.
// Fake clock, fixture IPC; no polling, network or real account data.
it('updates the shared count for deferral expiry, restore and deletion and clears it on owner change', async () => {
    const item = { id: 'count-unit', revision: 1, title: 'Count unit', notes: '', deadline: null, status: 'open' as const,
    deferredUntil: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  const api = window.electronAPI.localDb.personalTodos;
  vi.mocked(api.list).mockResolvedValue([item]);
  const component = render(<PersonalCount />);
  await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('1'));
  const now = Date.now();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(now);
  const deferred = { ...item, revision: 2, deferredUntil: new Date(Date.now() + 1000).toISOString() };
  vi.mocked(api.update).mockResolvedValueOnce(deferred);
  await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 1, operation: 'later', until: deferred.deferredUntil }); });
  expect(screen.getByTestId('personal-count').textContent).toBe('0');
  await act(async () => { vi.advanceTimersByTime(1001); });
  expect(screen.getByTestId('personal-count').textContent).toBe('1');
  const next = { ...deferred, revision: 3, deferredUntil: new Date(Date.now() + 1000).toISOString() };
  vi.mocked(api.update).mockResolvedValueOnce(next);
  await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 2, operation: 'later', until: next.deferredUntil }); });
  vi.mocked(api.update).mockResolvedValueOnce({ ...item, revision: 4 });
  await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 3, operation: 'restore' }); });
  expect(screen.getByTestId('personal-count').textContent).toBe('1');
  vi.mocked(api.update).mockResolvedValueOnce({ ...item, revision: 5 });
  await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 4, operation: 'delete' }); });
  expect(screen.getByTestId('personal-count').textContent).toBe('0');
  vi.mocked(api.list).mockResolvedValue([item]);
  await act(async () => { await refreshPersonalTodos(); });
  expect(screen.getByTestId('personal-count').textContent).toBe('1');
  vi.mocked(api.list).mockResolvedValue([]);
  h.generation = 2; setDataOwnerGeneration('other-test-owner', 2);
  await act(async () => { component.rerender(<PersonalCount />); });
  expect(screen.getByTestId('personal-count').textContent).toBe('0');
});

it('returns a restored personal todo to the visible open view with explicit feedback', async () => {
    const item = { id: 'restore-unit', revision: 1, title: 'Restore unit', notes: '', deadline: null, status: 'open' as const,
    deferredUntil: '2026-11-10T00:00:00Z', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  vi.mocked(window.electronAPI.localDb.personalTodos.list).mockResolvedValue([item]);
  render(<TeammateTodosView />);
  fireEvent.click(screen.getByRole('radio', { name: 'bots.todoBoard.view.later' }));
  await screen.findByRole('button', { name: item.title });
  fireEvent.click(screen.getByRole('button', { name: item.title }));
  vi.mocked(window.electronAPI.localDb.personalTodos.update).mockResolvedValue({ ...item, revision: 2, deferredUntil: null });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.restore' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'bots.todoBoard.view.open' }).getAttribute('aria-checked')).toBe('true'));
  expect(rowTitles()).toEqual([item.title]);
  expect(screen.getByRole('status').textContent).toContain('personalTodos.savedNotice');
});

it('keeps conflict drafts explicit and reveals a recovered creation after overwrite saving', async () => {
    const api = window.electronAPI.localDb.personalTodos;
  const item = { id: 'recover-unit', revision: 2, title: 'Committed original', notes: 'Latest notes', deadline: null, status: 'open' as const,
    deferredUntil: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  vi.mocked(api.update).mockImplementationOnce(async input => {
    vi.mocked(api.list).mockResolvedValue([{ ...item, creationRequestId: input.creationRequestId }]);
    throw new Error('[ALREADY_EXISTS] CONFLICT');
  });
  render(<TeammateTodosView />);
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.add' }));
  fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value: 'Retained draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.reloadVersion' }));
  await screen.findByRole('button', { name: 'personalTodos.overwrite' });
  expect((screen.getByLabelText('personalTodos.title') as HTMLInputElement).value).toBe('Retained draft');
  expect((screen.getByLabelText('personalTodos.notes') as HTMLTextAreaElement).value).toBe('');
  expect(screen.getByRole('alert').textContent).toBe('personalTodos.conflict');
  vi.mocked(api.update).mockResolvedValueOnce({ ...item, title: 'Retained draft', notes: '', revision: 3 });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.overwrite' }));
  await waitFor(() => expect(rowTitles()).toEqual(['Retained draft']));
  expect(vi.mocked(api.update).mock.lastCall?.[0]).toMatchObject({ id: item.id, expectedRevision: 2, title: 'Retained draft', notes: '' });
});

it('preserves persisted creation and completion time when adapting an edited completed todo', () => {
  const item = { id: 'time-unit', revision: 7, title: 'Unit time', notes: '', deadline: null, status: 'done' as const,
    deferredUntil: null, createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  const [row] = personalBoardItems([item], 'done');
  expect(row.todo.createdAt).toBe(item.createdAt);
  expect(row.todo.history.at(-1)?.at).toBe(item.completedAt);
  expect(row.todo.updatedAt).toBe(item.updatedAt);
});

it('sorts completed personal rows by persisted completion in both the fold and the done view', async () => {
    const older = { id: 'older-unit', revision: 3, title: 'Older completion edited later', notes: '', deadline: null, status: 'done' as const,
    deferredUntil: null, createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  const newer = { ...older, id: 'newer-unit', title: 'Newer completion', completedAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' };
  vi.mocked(window.electronAPI.localDb.personalTodos.list).mockResolvedValue([older, newer]);
  render(<TeammateTodosView />);
  await screen.findByRole('button', { name: 'bots.glance.doneCount:2' });
  fireEvent.click(screen.getByRole('button', { name: 'bots.glance.doneCount:2' }));
  expect(rowTitles()).toEqual([newer.title, older.title]);
  fireEvent.click(screen.getByRole('radio', { name: 'bots.todoBoard.view.done' }));
  expect(rowTitles()).toEqual([newer.title, older.title]);
});

// A: delayed first snapshot is a unit fixture; writes must overlay it, not cancel completeness.
it('merges a successful creation into the delayed first full snapshot without losing existing items or count', async () => {
    const existing = { id: 'existing-unit', revision: 1, title: 'Existing unit item', notes: '', deadline: null, status: 'open' as const,
    deferredUntil: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ownership: 'self' as const, source: 'manual' as const };
  const created = { ...existing, id: 'created-unit', title: 'New unit item' };
  let release!: (items: typeof existing[]) => void;
  const api = window.electronAPI.localDb.personalTodos;
  vi.mocked(api.list).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  vi.mocked(api.update).mockResolvedValueOnce(created);
  render(<><PersonalCount /><TeammateTodosView /></>);
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.add' }));
  fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value: created.title } });
  fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
  await screen.findByRole('button', { name: created.title });
  await act(async () => { release([existing]); });
  await waitFor(() => expect(rowTitles()).toEqual([existing.title, created.title]));
  expect(screen.getByTestId('personal-count').textContent).toBe('2');
  expect(api.list).toHaveBeenCalledTimes(1);
});

// B: jsdom UI + real production store in an auto-cleaned OS temp folder.
// The only fake is the IPC transport throwing after the first real atomic commit.
it('recovers the same committed creation after lost reply and edited retry, retaining the draft without duplicates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'personal-todo-ui-unit-'));
  const store = createPersonalTodoStore(path.join(root, 'todos.v1.json'));
  const api = window.electronAPI.localDb.personalTodos;
  let dropReply = true;
  vi.mocked(api.list).mockImplementation(() => store.list());
  vi.mocked(api.update).mockImplementation(async input => {
    try {
      const saved = await store.update(input);
      if (dropReply) { dropReply = false; throw new Error('Unit IPC reply lost after atomic commit'); }
      return saved;
    } catch (error) {
      if ((error as { code?: string }).code === 'CONFLICT') throw new Error('[ALREADY_EXISTS] CONFLICT');
      throw error;
    }
  });
  const component = render(<TeammateTodosView />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.add' }));
    fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value: 'Original unit submission' } });
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
    await screen.findByRole('alert');
    const [committed] = await store.list();
    expect(committed.title).toBe('Original unit submission');
    fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value: 'Edited retained unit draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.save' }));
    await screen.findByRole('button', { name: 'personalTodos.reloadVersion' });
    expect(vi.mocked(api.update).mock.calls[0][0].creationRequestId).toBe(vi.mocked(api.update).mock.calls[1][0].creationRequestId);
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.reloadVersion' }));
    await screen.findByRole('button', { name: 'personalTodos.overwrite' });
    expect((screen.getByLabelText('personalTodos.title') as HTMLInputElement).value).toBe('Edited retained unit draft');
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.overwrite' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Edited retained unit draft']));
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: committed.id, title: 'Edited retained unit draft' });
  } finally { component.unmount(); await rm(root, { recursive: true, force: true }); }
});
