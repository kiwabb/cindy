// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalTodoStore } from '../../../../main/maker-ipc/personalTodoStore';
import userEvent from '@testing-library/user-event';

/**
 * 测试价值
 * - 生产入口与可观察结果：「待办」页（TeammateTodosView，路由 /bots/todos）。主人看到的分段与顺序、
 *   稍后再说与已完成不混进进行中、伙伴与状态筛选、点一条打开那位伙伴的对话；离线电脑上的伙伴不去读，
 *   读到过的置灰保留，读失败给重试；「我的待办」与「伙伴待办」两份清单不混排，我的待办在行内新增、
 *   按分组展示，并在详情面板里改优先级、标签与提醒。
 * - Bug／规则依据：2026-11-06 主人确认的待办面板原型（单列表按截止分段、只读、离线整行置灰）；
 *   2026-11 个人待办改版（owner 批准的原型）第 1–9 条；docs/product-rules/cindy-bots-runtime.md §6.3.6。
 * - 现有覆盖缺口：新页面；近况测试只覆盖单个伙伴、且只列 7 天内到期的。
 * - 最小失败输入：本机伙伴 + 在线远程伙伴 + 离线远程伙伴，各段各一条，外加一条稍后再说与一条已完成；
 *   存档里的旧范围「all」；输入法组字时按回车；标签 id 不在目录里。
 * - tier：unit（jsdom 渲染真实页面与真实读取路径，宿主与 device-link 用内存 fake）。
 */
import { refreshPersonalTodos, updatePersonalTodo, personalTodoCacheTesting } from '../personalTodoCache';
import { useTodoBoardOpenCount } from '../useTeammateTodoBoard';
import { addDays, quickDate } from '../todoDates';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resetTaskTagCatalogCache } from '@/features/task-tags/taskTagEvents';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryTodoItems,
  todoLocalDate,
  validateTodoDeadline,
  type TeammateTodo,
  type TodoListQuery,
} from '@cindy/maker-shared/teammate-todo';
import { TASK_TAG_COLORS, type TaskTag } from '@cindy/maker-shared';
import type { PersonalTodo } from '../../../../shared/personalTodo';

const h = vi.hoisted(() => ({
  generation: 1,
  navigate: vi.fn(),
  local: [] as Array<Record<string, unknown>>,
  remote: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join('|')}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => h.generation }));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));
vi.mock('../BotGlancePopover', () => ({ TodoDueDot: () => <span data-testid="due-dot" /> }));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.local }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => h.remote }));
vi.mock('../companionCloudStore', () => ({
  useCompanionCloud: () => ({ enabled: false, selfDeviceId: null, actors: [], demotedBotIds: [] }),
}));
// Menus and popovers render their content inline so the choices can be exercised without pointer
// plumbing; the real components keep their own tests.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  const Group = React.createContext<{ value: string; onValueChange: (value: string) => void }>({
    value: '',
    onValueChange: () => undefined,
  });
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
      <button type="button" role="menuitem" onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
    DropdownMenuRadioGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) => <Group.Provider value={{ value, onValueChange }}>{children}</Group.Provider>,
    DropdownMenuRadioItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const group = React.useContext(Group);
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={group.value === value}
          onClick={() => group.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

const { TeammateTodosView } = await import('../TeammateTodosView');
const { __testing } = await import('../teammateTodoBoard');

function todo(id: string, patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id, revision: 1, key: id, origin: 'assigned', title: id, progress: '', outcome: '', value: '',
    next: null, sources: [{ kind: 'conversation', id: `c:${id}`, label: '' }], associations: [], status: 'open',
    createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', sourceDeadline: null,
    deadlineCandidate: null, suggestedDate: null, decision: null, history: [], action: null, ...patch,
  };
}
const date = (value: string) => ({ kind: 'date' as const, date: value, timeZone: 'UTC' });
const mine = (id: string, patch: Partial<PersonalTodo> = {}): PersonalTodo => ({
  id, revision: 1, title: id, notes: '', deadline: null, status: 'open', deferredUntil: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', priority: 0, tagIds: [],
  reminder: 'default', ownership: 'self', source: 'manual', ...patch,
});
const tag = (id: string, name: string, sortOrder: number): TaskTag => ({
  id, name, color: 'blue', favoriteOrder: null, sortOrder, revision: 1,
});

let localItems: TeammateTodo[] = [];
let remoteItems: TeammateTodo[] = [];
let remoteFails = false;
let catalog: TaskTag[] = [];
const invoke = vi.fn(async (_deviceId: string, _channel: string, [request]: [{ query: string }]) => {
  if (remoteFails) throw new Error('offline');
  return { blocks: [{ primitive: 'teammate-todos', data: queryTodoItems(remoteItems, JSON.parse(request.query) as TodoListQuery) }] };
});
const tagExecute = vi.fn();

beforeEach(() => {
  // 2026-11-06 是周五；本周到 11-08 周日为止。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T02:30:00Z'));
  h.generation = 1;
  setDataOwnerGeneration('test-owner', 1);
  __testing.reset();
  personalTodoCacheTesting.reset();
  resetTaskTagCatalogCache();
  localStorage.clear();
  localStorage.setItem('personal-todo-view:test-owner', 'teammates');
  remoteFails = false;
  catalog = [tag('t-work', 'Work', 0), tag('t-life', 'Life', 1)];
  tagExecute.mockReset();
  tagExecute.mockImplementation(async () => ({ tags: catalog, sessions: [], supportedColors: [...TASK_TAG_COLORS] }));
  h.local = [{ id: 'cindy', name: 'Cindy', avatar: '', avatarColor: 'violet' }];
  h.remote = [
    { id: 'dev', name: '开发管家', deviceId: 'mini', deviceName: 'Mac mini', online: true, avatar: '', avatarColor: 'blue' },
    { id: 'life', name: '栖物生活', deviceId: 'home', deviceName: '家里的 Mac mini', online: false, avatar: '', avatarColor: 'green' },
  ];
  localItems = [
    todo('交报销单', { sourceDeadline: date('2026-11-04'), next: { kind: 'decide', label: '先交哪些', instruction: '' } }),
    todo('回复张雯', { origin: 'discovered', sourceDeadline: { kind: 'instant', date: '2026-11-06', timeZone: 'UTC', at: '2026-11-06T09:00:00Z' } }),
    todo('预约牙医', { suggestedDate: '2026-11-10' }),
    todo('换办公椅', { decision: { kind: 'later', until: '2026-11-15T01:00:00Z' } }),
    todo('不再提示的', { decision: { kind: 'muted' } }),
    todo('交 OKR 自评', { status: 'done', history: [{ summary: '已提交', at: '2026-11-04T08:00:00Z' }] }),
  ];
  remoteItems = [
    todo('审阅合并请求', { origin: 'discovered', sourceDeadline: date('2026-11-08') }),
    todo('升级 Electron', { sourceDeadline: date('2026-11-14') }),
  ];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: {
      personalTodos: { list: vi.fn(async () => []), update: vi.fn() },
      taskTags: { execute: tagExecute, onChanged: () => () => undefined },
      bots: { todos: { list: async () => ({ items: localItems, version: 1 }), dailyCheck: vi.fn() } },
    },
    maker: { onBotWorkbenchChanged: () => () => undefined },
    routines: { onChanged: () => () => undefined },
    deviceLink: { invoke, onRemotePush: () => () => undefined },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const rowTitles = (root: HTMLElement = document.body) =>
  within(root).queryAllByTestId('todo-board-row').map((row) => row.querySelector('.truncate')?.textContent);
/** Segmented options read "label count". */
const radio = (name: string) =>
  screen.getByRole('radio', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`) });
const api = () => window.electronAPI.localDb.personalTodos;
const update = () => vi.mocked(api().update);
const showMine = () => localStorage.setItem('personal-todo-view:test-owner', 'mine');
const editorPanel = () => within(screen.getByLabelText('personalTodos.details'));
const openComposer = () => fireEvent.click(screen.getByRole('button', { name: 'personalTodos.add' }));
const typeTitle = (value: string) =>
  fireEvent.change(screen.getByLabelText('personalTodos.title'), { target: { value } });
const submitComposer = () => fireEvent.click(screen.getByRole('button', { name: 'personalTodos.composer.add' }));

describe('TeammateTodosView', () => {
  it('merges every teammate into one deadline-ordered list and keeps snoozed, muted and done out of it', async () => {
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
      // 只有建议日期的不制造紧迫感，归「无截止」，但仍标出建议日期。
      { label: 'bots.todoBoard.bucket.none', rows: ['预约牙医'] },
    ]);
    expect(screen.getByText(/^bots\.todoBoard\.suggested:/)).toBeTruthy();
    // 离线电脑上的伙伴不去读，并说明看不到它的待办。
    expect(invoke.mock.calls.every(([deviceId]) => deviceId === 'mini')).toBe(true);
    expect(screen.getByTestId('todo-board-notes').textContent).toContain('bots.todoBoard.offlineUnknown:栖物生活|家里的 Mac mini');
    // 标签筛选与分组菜单只属于「我的待办」。
    expect(screen.queryByRole('menuitemradio', { name: 'personalTodos.group.due' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'taskTags.title' })).toBeNull();

    // 已完成只在「已完成」里，不再折叠在进行中底部。
    expect(screen.queryByText('交 OKR 自评')).toBeNull();
    fireEvent.click(radio('bots.todoBoard.view.done'));
    expect(rowTitles()).toEqual(['交 OKR 自评']);

    // 稍后再说单独一档，带再提醒的日期；不再提示的哪里都不出现。
    fireEvent.click(radio('bots.todoBoard.view.later'));
    expect(rowTitles()).toEqual(['换办公椅']);
    expect(screen.getByText(/^bots\.todoBoard\.laterUntil:/)).toBeTruthy();
    expect(screen.queryByText('不再提示的')).toBeNull();

    // 按伙伴筛选，点一条打开那位伙伴在它电脑上的对话。
    fireEvent.click(radio('bots.todoBoard.view.open'));
    fireEvent.click(screen.getByRole('button', { name: '开发管家', pressed: false }));
    expect(rowTitles()).toEqual(['审阅合并请求', '升级 Electron']);
    fireEvent.click(screen.getAllByTestId('todo-board-row')[0]);
    expect(h.navigate).toHaveBeenCalledWith('/bots/remote/mini/dev');

    // 类型筛选：只看伙伴发现的。
    fireEvent.click(screen.getByRole('button', { name: 'bots.todoBoard.origin.all', pressed: false }));
    fireEvent.click(screen.getByRole('radio', { name: 'bots.todoBoard.origin.discovered' }));
    expect(rowTitles()).toEqual(['回复张雯', '审阅合并请求']);
  });

  it('keeps the last todos of a teammate whose computer went offline, and retries a failed read', async () => {
    h.local = [];
    const view = render(<TeammateTodosView />);
    await waitFor(() => expect(rowTitles()).toEqual(['审阅合并请求', '升级 Electron']));

    h.remote = h.remote.map((bot) => (bot.id === 'dev' ? { ...bot, online: false } : bot));
    view.rerender(<TeammateTodosView />);
    expect(rowTitles()).toEqual(['审阅合并请求', '升级 Electron']);
    expect(screen.getByTestId('todo-board-notes').textContent).toContain('bots.todoBoard.offlineCached:开发管家|Mac mini');

    // 换成在线但读不到：说明读不到，点重试再读一次。
    h.generation = 1;
    setDataOwnerGeneration('test-owner', 1);
    __testing.reset();
    personalTodoCacheTesting.reset();
    localStorage.setItem('personal-todo-view:test-owner', 'teammates');
    remoteFails = true;
    h.remote = h.remote.map((bot) => (bot.id === 'dev' ? { ...bot, online: true } : bot));
    view.unmount();
    render(<TeammateTodosView />);
    await screen.findByText('bots.todoBoard.loadFailed:开发管家');
    expect(rowTitles()).toEqual([]);
    remoteFails = false;
    fireEvent.click(screen.getByText('commonUi.retry'));
    await waitFor(() => expect(rowTitles()).toEqual(['审阅合并请求', '升级 Electron']));
    expect(screen.queryByText('bots.todoBoard.loadFailed:开发管家')).toBeNull();
  });
});

describe('personal and teammate lists', () => {
  // The retired mixed list ('all') and anything unknown must open on 我的待办, never on a mixed list.
  it.each([null, 'all', 'bogus'])('opens on my todos with the stored scope %s and does not mix in teammate todos', async (stored) => {
    localStorage.removeItem('personal-todo-view:test-owner');
    if (stored) localStorage.setItem('personal-todo-view:test-owner', stored);
    h.local = [];
    vi.mocked(api().list).mockResolvedValue([mine('Mine only')]);
    render(<TeammateTodosView />);
    await waitFor(() => expect(rowTitles()).toEqual(['Mine only']));
    expect(radio('personalTodos.mine').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio', { name: /personalTodos\.all/ })).toBeNull();
    // Both counts are open items of their own list; the teammate side finishes loading on its own.
    await waitFor(() => expect(radio('personalTodos.teammates').getAttribute('aria-label')).toBe('personalTodos.teammates 2'));
    expect(radio('personalTodos.mine').getAttribute('aria-label')).toBe('personalTodos.mine 1');
    expect(radio('bots.todoBoard.view.open').getAttribute('aria-label')).toBe('bots.todoBoard.view.open 1');

    fireEvent.click(radio('personalTodos.teammates'));
    await waitFor(() => expect(rowTitles()).toEqual(['审阅合并请求', '升级 Electron']));
    expect(radio('bots.todoBoard.view.open').getAttribute('aria-label')).toBe('bots.todoBoard.view.open 2');
    expect(localStorage.getItem('personal-todo-view:test-owner')).toBe('teammates');
  });

  it('shows the composer only under my todos and open', async () => {
    showMine();
    h.local = []; h.remote = [];
    vi.mocked(api().list).mockResolvedValue([mine('Snoozed', { deferredUntil: '2026-11-20T00:00:00Z' })]);
    render(<TeammateTodosView />);
    expect(screen.getByRole('button', { name: 'personalTodos.add' })).toBeTruthy();
    fireEvent.click(radio('bots.todoBoard.view.later'));
    await screen.findByRole('button', { name: 'Snoozed' });
    expect(screen.queryByRole('button', { name: 'personalTodos.add' })).toBeNull();
    fireEvent.click(radio('personalTodos.teammates'));
    expect(screen.queryByRole('button', { name: 'personalTodos.add' })).toBeNull();
  });
});

describe('personal todo composer', () => {
  beforeEach(() => {
    showMine();
    h.local = []; h.remote = [];
  });

  // Existing page unit tier: fixture IPC only, no real account writes/model calls.
  // New coverage: title-only inline add, rejection retaining input, successful retry on the same request id,
  // completion and reopening through rendered production handlers without a teammate.
  it('adds without teammates, keeps the draft and request id on a failed save, and edits, completes and reopens the item', async () => {
    const item = mine('personal-1', { title: 'Unit personal item' });
    update().mockRejectedValueOnce(new Error('Disk failure')).mockResolvedValueOnce(item);
    render(<TeammateTodosView />);
    openComposer();
    typeTitle(item.title);
    submitComposer();
    await screen.findByRole('alert');
    expect((screen.getByLabelText('personalTodos.title') as HTMLInputElement).value).toBe(item.title);
    submitComposer();
    await waitFor(() => expect(rowTitles()).toEqual([item.title]));
    expect(update().mock.calls[0][0].creationRequestId).toBe(update().mock.calls[1][0].creationRequestId);
    // The composer stays open for the next item, empty.
    expect((screen.getByLabelText('personalTodos.title') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(screen.getByTestId('todo-board-row')).getByRole('button', { name: item.title }));
    fireEvent.change(editorPanel().getByLabelText('personalTodos.notes'), { target: { value: 'Edited notes' } });
    update().mockResolvedValueOnce({ ...item, revision: 2, notes: 'Edited notes' });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.save' }));
    await waitFor(() => expect(screen.queryByLabelText('personalTodos.details')).toBeNull());
    fireEvent.click(within(screen.getByTestId('todo-board-row')).getByRole('button', { name: item.title }));
    expect((editorPanel().getByLabelText('personalTodos.notes') as HTMLTextAreaElement).value).toBe('Edited notes');
    update().mockResolvedValueOnce({ ...item, revision: 3, status: 'done' });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.complete' }));
    await waitFor(() => expect(rowTitles()).toEqual([]));
    fireEvent.click(radio('bots.todoBoard.view.done'));
    fireEvent.click(within(screen.getByTestId('todo-board-row')).getByRole('button', { name: item.title }));
    update().mockResolvedValueOnce({ ...item, revision: 4 });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.reopen' }));
    await waitFor(() => expect(radio('bots.todoBoard.view.open').getAttribute('aria-checked')).toBe('true'));
    expect(rowTitles()).toEqual([item.title]);
  });

  it('ignores Enter while an input method is composing and adds on a plain Enter exactly once', async () => {
    update().mockResolvedValue(mine('ime-1', { title: '写周报' }));
    render(<TeammateTodosView />);
    openComposer();
    const input = screen.getByLabelText('personalTodos.title');
    typeTitle('写周报');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(update()).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(1));
    expect(update().mock.lastCall?.[0]).toMatchObject({ title: '写周报', priority: 0, tagIds: [], deadline: null });
    // Esc collapses the composer back to its row.
    fireEvent.keyDown(screen.getByLabelText('personalTodos.title'), { key: 'Escape' });
    expect(screen.queryByLabelText('personalTodos.title')).toBeNull();
    expect(screen.getByRole('button', { name: 'personalTodos.add' })).toBeTruthy();
  });

  it('turns a recognised date phrase into the deadline and strips it from the title, until dismissed or overridden', async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tomorrow = addDays(todoLocalDate(new Date(), zone), 1);
    update().mockImplementation(async (input) => mine('dated', { title: input.title ?? '' }));
    render(<TeammateTodosView />);
    openComposer();
    typeTitle('send the report tomorrow at 3pm');
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.composer.dismissRecognition:tomorrow at 3pm' }));
    // Dismissed: the whole text stays the title and nothing is dated.
    submitComposer();
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(1));
    expect(update().mock.lastCall?.[0]).toMatchObject({ title: 'send the report tomorrow at 3pm', deadline: null });

    // Recognised: the phrase leaves the title and the deadline is a valid instant on the right local date.
    typeTitle('send the report tomorrow at 3pm');
    expect(screen.getByRole('button', { name: 'personalTodos.composer.dismissRecognition:tomorrow at 3pm' })).toBeTruthy();
    submitComposer();
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(2));
    const sent = update().mock.lastCall![0];
    expect(sent.title).toBe('send the report');
    expect(sent.deadline).toMatchObject({ kind: 'instant', date: tomorrow, timeZone: zone });
    expect(() => validateTodoDeadline(sent.deadline!)).not.toThrow();

    // A date picked by hand wins over the phrase, and the title keeps its words.
    typeTitle('call mom tomorrow');
    fireEvent.click(screen.getByRole('menuitem', { name: /personalTodos\.due\.nextMonday/ }));
    expect(screen.queryByRole('button', { name: /dismissRecognition/ })).toBeNull();
    submitComposer();
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(3));
    expect(update().mock.lastCall![0]).toMatchObject({
      title: 'call mom tomorrow',
      deadline: { kind: 'date', date: quickDate('nextMonday', new Date(), zone) },
    });
  });

  it('sends the chosen priority and tag and keeps the tag for the next item', async () => {
    update().mockImplementation(async (input) => mine('tagged', { title: input.title ?? '' }));
    render(<TeammateTodosView />);
    openComposer();
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Work' })).toBeTruthy());
    typeTitle('Draft spec');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'personalTodos.priority.high' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Work' }));
    submitComposer();
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(1));
    expect(update().mock.lastCall![0]).toMatchObject({ title: 'Draft spec', priority: 3, tagIds: ['t-work'] });
    expect(screen.getByRole('menuitemradio', { name: 'Work' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'personalTodos.priority.none' }).getAttribute('aria-checked')).toBe('true');
    typeTitle('Next');
    submitComposer();
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(2));
    expect(update().mock.lastCall![0]).toMatchObject({ priority: 0, tagIds: ['t-work'] });
  });

  it('creates a tag from the composer and selects it, and reports a host error', async () => {
    render(<TeammateTodosView />);
    openComposer();
    fireEvent.click(screen.getByRole('menuitem', { name: 'personalTodos.newTag' }));
    const name = screen.getByLabelText('taskTags.name');
    fireEvent.change(name, { target: { value: 'Errands' } });
    fireEvent.click(screen.getByRole('radio', { name: 'taskTags.orange' }));
    const created = tag('t-errands', 'Errands', 2);
    tagExecute.mockRejectedValueOnce(new Error('[ALREADY_EXISTS] duplicate'));
    fireEvent.click(screen.getByRole('button', { name: 'taskTags.create' }));
    expect((await screen.findByRole('alert')).textContent).toBe('taskTags.alreadyExists');
    tagExecute.mockImplementationOnce(async () => ({ tags: [...catalog, created], sessions: [], supportedColors: [...TASK_TAG_COLORS] }));
    fireEvent.click(screen.getByRole('button', { name: 'taskTags.create' }));
    await waitFor(() => expect(screen.queryByLabelText('taskTags.name')).toBeNull());
    expect(tagExecute).toHaveBeenLastCalledWith({ action: 'create', name: 'Errands', color: 'orange' });
    expect(screen.getByRole('menuitemradio', { name: 'Errands' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps conflict drafts explicit and reveals a recovered creation after overwrite saving', async () => {
    const item = mine('recover-unit', { revision: 2, title: 'Committed original', notes: 'Latest notes', updatedAt: '2026-11-02T00:00:00Z' });
    update().mockImplementationOnce(async (input) => {
      vi.mocked(api().list).mockResolvedValue([{ ...item, creationRequestId: input.creationRequestId }]);
      throw new Error('[ALREADY_EXISTS] CONFLICT');
    });
    render(<TeammateTodosView />);
    openComposer();
    typeTitle('Retained draft');
    submitComposer();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.reloadVersion' }));
    await screen.findByRole('button', { name: 'personalTodos.overwrite' });
    expect((screen.getByLabelText('personalTodos.title') as HTMLInputElement).value).toBe('Retained draft');
    expect((screen.getByLabelText('personalTodos.notes') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('alert').textContent).toBe('personalTodos.conflict');
    update().mockResolvedValueOnce({ ...item, title: 'Retained draft', notes: '', revision: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'personalTodos.overwrite' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Retained draft']));
    expect(update().mock.lastCall?.[0]).toMatchObject({ id: item.id, expectedRevision: 2, title: 'Retained draft', notes: '' });
    expect(radio('personalTodos.mine').getAttribute('aria-checked')).toBe('true');
  });

  // A: delayed first snapshot is a unit fixture; writes must overlay it, not cancel completeness.
  it('merges a successful creation into the delayed first full snapshot without losing existing items or count', async () => {
    const existing = mine('existing-unit', { title: 'Existing unit item', createdAt: '2026-01-01T00:00:00Z' });
    const created = mine('created-unit', { title: 'New unit item', createdAt: '2026-11-06T00:00:00Z' });
    let release!: (items: PersonalTodo[]) => void;
    vi.mocked(api().list).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    update().mockResolvedValueOnce(created);
    render(<><PersonalCount /><TeammateTodosView /></>);
    openComposer();
    typeTitle(created.title);
    submitComposer();
    await screen.findByRole('button', { name: created.title });
    await act(async () => { release([existing]); });
    // Same priority and no deadline: the newer item reads first.
    await waitFor(() => expect(rowTitles()).toEqual([created.title, existing.title]));
    expect(screen.getByTestId('personal-count').textContent).toBe('2');
    expect(api().list).toHaveBeenCalledTimes(1);
  });

  // B: jsdom UI + real production store in an auto-cleaned OS temp folder.
  // The only fake is the IPC transport throwing after the first real atomic commit.
  it('recovers the same committed creation after lost reply and edited retry, retaining the draft without duplicates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'personal-todo-ui-unit-'));
    const store = createPersonalTodoStore(path.join(root, 'todos.v1.json'));
    let dropReply = true;
    vi.mocked(api().list).mockImplementation(() => store.list());
    update().mockImplementation(async (input) => {
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
      openComposer();
      typeTitle('Original unit submission');
      submitComposer();
      await screen.findByRole('alert');
      const [committed] = await store.list();
      expect(committed.title).toBe('Original unit submission');
      typeTitle('Edited retained unit draft');
      submitComposer();
      await screen.findByRole('button', { name: 'personalTodos.reloadVersion' });
      expect(update().mock.calls[0][0].creationRequestId).toBe(update().mock.calls[1][0].creationRequestId);
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
});

describe('personal todo list', () => {
  beforeEach(() => {
    showMine();
    h.local = []; h.remote = [];
  });

  it('groups by deadline by default, remembers the chosen grouping per account, and shows the tag only when it adds something', async () => {
    vi.mocked(api().list).mockResolvedValue([
      mine('Overdue', { priority: 3, deadline: { kind: 'date', date: '2026-11-04', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, tagIds: ['t-work'] }),
      mine('Plain', { priority: 1 }),
      mine('Ghost tag', { tagIds: ['gone'] }),
    ]);
    render(<TeammateTodosView />);
    await waitFor(() => expect(rowTitles()).toHaveLength(3));
    const labels = () => [...document.querySelectorAll('section')].map((section) => section.querySelector('h3')?.textContent);
    expect(labels()).toEqual(['bots.todoBoard.bucket.overdue', 'bots.todoBoard.bucket.none']);
    // A tag id missing from the catalog reads as untagged; a known one shows next to the row.
    const rows = screen.getAllByTestId('todo-board-row');
    expect(within(rows[0]).getByText('Work')).toBeTruthy();
    expect(within(rows[0]).getByText(/^personalTodos\.due\.overdue:/).className).toContain('--error-fg');
    expect(rows[1].textContent).not.toContain('Work');
    expect(rows[2].textContent).toBe('Ghost tag');
    expect(rows.map((row) => within(row).getByRole('checkbox').getAttribute('aria-label'))).toEqual([
      'personalTodos.complete: Overdue · personalTodos.priority.high',
      'personalTodos.complete: Plain · personalTodos.priority.low',
      'personalTodos.complete: Ghost tag',
    ]);

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'personalTodos.group.priority' }));
    expect(labels()).toEqual(['personalTodos.priority.short.high', 'personalTodos.priority.short.low', 'personalTodos.priority.none']);
    expect(localStorage.getItem('personal-todo-grouping:test-owner')).toBe('priority');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'personalTodos.group.tag' }));
    expect(labels()).toEqual(['Work', 'personalTodos.untagged']);
    // Grouped by tag, the row no longer repeats it.
    expect(within(screen.getAllByTestId('todo-board-row')[0]).queryByText('Work')).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'personalTodos.order.due' }));
    expect(localStorage.getItem('personal-todo-order:test-owner')).toBe('due');

    // Another account keeps its own choice.
    cleanup();
    setDataOwnerGeneration('other-owner', 2);
    h.generation = 2;
    render(<TeammateTodosView />);
    expect(screen.getByRole('menuitemradio', { name: 'personalTodos.group.due' }).getAttribute('aria-checked')).toBe('true');
  });

  it('filters by tag chips and counts only open items per tag', async () => {
    vi.mocked(api().list).mockResolvedValue([
      mine('Work one', { tagIds: ['t-work'] }),
      mine('Work two', { tagIds: ['t-work'] }),
      mine('Life one', { tagIds: ['t-life'], status: 'done', completedAt: '2026-11-05T00:00:00Z' }),
      mine('Loose'),
    ]);
    render(<TeammateTodosView />);
    const chips = await screen.findByRole('group', { name: 'taskTags.title' });
    // Life has no open items, so it is not offered; 无标签 counts the loose one.
    expect(within(chips).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'personalTodos.all3', 'Work2', 'personalTodos.untagged1',
    ]);
    fireEvent.click(within(chips).getByRole('button', { name: /Work/ }));
    expect(rowTitles()).toEqual(['Work one', 'Work two']);
    fireEvent.click(within(chips).getByRole('button', { name: /personalTodos\.untagged/ }));
    expect(rowTitles()).toEqual(['Loose']);
  });
});

describe('personal todo details', () => {
  beforeEach(() => {
    showMine();
    h.local = []; h.remote = [];
  });

  // Store contract (INVALID_PARAMS for past deferral; instant needs at on the local date): validated/built in the editor.
  it('sends a time-of-day deadline as an instant and rejects a deferral that is not in the future before saving', async () => {
    const openItem = mine('form-unit', { title: 'Form unit' });
    vi.mocked(api().list).mockResolvedValue([openItem]);
    render(<TeammateTodosView />);
    fireEvent.click(await screen.findByRole('button', { name: openItem.title }));
    fireEvent.change(editorPanel().getByLabelText('personalTodos.deferUntil'), { target: { value: '2026-11-05T10:00' } });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.defer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('personalTodos.deferInPast');
    expect(update()).not.toHaveBeenCalled();

    fireEvent.change(editorPanel().getByLabelText('personalTodos.deadline'), { target: { value: '2026-11-20' } });
    fireEvent.change(editorPanel().getByLabelText('personalTodos.deadlineTime'), { target: { value: '09:30' } });
    update().mockResolvedValueOnce({ ...openItem, revision: 2 });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.save' }));
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(1));
    const sent = update().mock.lastCall![0];
    expect(sent.deadline).toEqual({
      kind: 'instant', date: '2026-11-20', at: new Date('2026-11-20T09:30').toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    // Nothing else was touched, so nothing else is sent.
    expect(sent).not.toHaveProperty('priority');
    expect(sent).not.toHaveProperty('tagIds');
    expect(sent).not.toHaveProperty('reminder');
  });

  it('sends the priority, tag and reminder the owner changed and offers reminders that fit the deadline', async () => {
    const item = mine('edit-unit', { title: 'Edit unit', tagIds: ['t-life'], priority: 1 });
    vi.mocked(api().list).mockResolvedValue([item]);
    render(<TeammateTodosView />);
    fireEvent.click(await screen.findByRole('button', { name: item.title }));
    // No deadline, no reminder row.
    expect(editorPanel().queryByRole('radiogroup', { name: 'personalTodos.reminder.label' })).toBeNull();
    expect(editorPanel().getByRole('radio', { name: 'personalTodos.priority.low' }).getAttribute('aria-checked')).toBe('true');
    expect(editorPanel().getByRole('button', { name: 'Life', pressed: true })).toBeTruthy();

    fireEvent.click(editorPanel().getByRole('radio', { name: 'personalTodos.priority.high' }));
    fireEvent.click(editorPanel().getByRole('button', { name: 'Work' }));
    fireEvent.change(editorPanel().getByLabelText('personalTodos.deadline'), { target: { value: '2026-11-20' } });
    // Date only: day-of / day-before / off.
    const dateReminders = within(editorPanel().getByRole('radiogroup', { name: 'personalTodos.reminder.label' }));
    expect(dateReminders.getAllByRole('radio').map((option) => option.textContent)).toEqual([
      'personalTodos.reminder.dayOf', 'personalTodos.reminder.dayBefore', 'personalTodos.reminder.off',
    ]);
    fireEvent.change(editorPanel().getByLabelText('personalTodos.deadlineTime'), { target: { value: '09:30' } });
    const timeReminders = within(editorPanel().getByRole('radiogroup', { name: 'personalTodos.reminder.label' }));
    expect(timeReminders.getAllByRole('radio').map((option) => option.textContent)).toEqual([
      'personalTodos.reminder.onTime', 'personalTodos.reminder.before15m', 'personalTodos.reminder.before1h', 'personalTodos.reminder.off',
    ]);
    fireEvent.click(timeReminders.getByRole('radio', { name: 'personalTodos.reminder.before15m' }));
    update().mockResolvedValueOnce({ ...item, revision: 2 });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.save' }));
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(1));
    expect(update().mock.lastCall![0]).toMatchObject({ id: item.id, expectedRevision: 1, priority: 3, tagIds: ['t-work'], reminder: 'before-15m' });
  });

  it('defers from a quick choice with the resume time in the computer\'s time zone', async () => {
    const item = mine('defer-unit', { title: 'Defer unit' });
    vi.mocked(api().list).mockResolvedValue([item]);
    render(<TeammateTodosView />);
    fireEvent.click(await screen.findByRole('button', { name: item.title }));
    update().mockResolvedValueOnce({ ...item, revision: 2, deferredUntil: '2026-11-07T01:00:00Z' });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.due.tomorrow' }));
    await waitFor(() => expect(update()).toHaveBeenCalledTimes(1));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(update().mock.lastCall![0]).toMatchObject({
      operation: 'later',
      until: new Date(`${quickDate('tomorrow', new Date(), zone)}T09:00`).toISOString(),
    });
  });

  it('returns a restored personal todo to the visible open view with explicit feedback', async () => {
    const item = mine('restore-unit', { title: 'Restore unit', deferredUntil: '2026-11-10T00:00:00Z' });
    vi.mocked(api().list).mockResolvedValue([item]);
    render(<TeammateTodosView />);
    fireEvent.click(radio('bots.todoBoard.view.later'));
    await screen.findByRole('button', { name: item.title });
    fireEvent.click(screen.getByRole('button', { name: item.title }));
    update().mockResolvedValue({ ...item, revision: 2, deferredUntil: null });
    fireEvent.click(editorPanel().getByRole('button', { name: 'personalTodos.restore' }));
    await waitFor(() => expect(radio('bots.todoBoard.view.open').getAttribute('aria-checked')).toBe('true'));
    expect(rowTitles()).toEqual([item.title]);
    expect(screen.getByRole('status').textContent).toContain('personalTodos.savedNotice');
  });

  it('sorts completed personal rows by persisted completion in the done view only', async () => {
    const older = mine('older-unit', { revision: 3, title: 'Older completion edited later', status: 'done', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z' });
    const newer = { ...older, id: 'newer-unit', title: 'Newer completion', completedAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' };
    vi.mocked(api().list).mockResolvedValue([older, newer]);
    render(<TeammateTodosView />);
    await waitFor(() => expect(radio('bots.todoBoard.view.done').getAttribute('aria-label')).toBe('bots.todoBoard.view.done 2'));
    // 未完成里不再折叠出已完成。
    expect(rowTitles()).toEqual([]);
    fireEvent.click(radio('bots.todoBoard.view.done'));
    expect(rowTitles()).toEqual([newer.title, older.title]);
  });
});

function PersonalCount() { return <output data-testid="personal-count">{useTodoBoardOpenCount()}</output>; }

describe('personal todo toggles and the shared count', () => {
  // Unit fixtures only: the sidebar count shares one read and observes completion/reopening without polling.
  it('creates from the composer, shares inline updates with the badge and retries a failed toggle', async () => {
    showMine();
    h.local = []; h.remote = [];
    const item = mine('visible-unit', { title: 'Visible unit todo', updatedAt: '2026-11-06T00:00:00Z' });
    update().mockResolvedValueOnce(item);
    render(<><PersonalCount /><TeammateTodosView /></>);
    await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('0'));
    openComposer();
    typeTitle(item.title);
    submitComposer();
    await waitFor(() => expect(rowTitles()).toEqual([item.title]));
    expect(screen.getByTestId('personal-count').textContent).toBe('1');
    expect(radio('personalTodos.mine').getAttribute('aria-checked')).toBe('true');
    expect(radio('bots.todoBoard.view.open').getAttribute('aria-checked')).toBe('true');
    expect(api().list).toHaveBeenCalledTimes(1);
    update().mockRejectedValueOnce(new Error('Unit write failed'));
    const toggle = screen.getByRole('checkbox', { name: `personalTodos.complete: ${item.title}` });
    toggle.focus();
    await userEvent.keyboard(' ');
    await screen.findByText('personalTodos.rowFailed');
    expect(screen.getByTestId('personal-count').textContent).toBe('1');
    update().mockResolvedValueOnce({ ...item, revision: 2, status: 'done', completedAt: '2026-11-06T00:00:00Z' });
    fireEvent.click(screen.getByRole('checkbox', { name: `personalTodos.complete: ${item.title}` }));
    await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('0'));
    fireEvent.click(radio('bots.todoBoard.view.done'));
    update().mockResolvedValueOnce({ ...item, revision: 3 });
    fireEvent.click(screen.getByRole('checkbox', { name: `personalTodos.reopen: ${item.title}` }));
    await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('1'));
    expect(rowTitles()).toEqual([item.title]);
  });

  // Unit cache lifecycle: one mounted badge observes local mutations and the real deadline timer.
  // Fake clock, fixture IPC; no polling, network or real account data.
  it('updates the shared count for deferral expiry, restore and deletion and clears it on owner change', async () => {
    h.local = []; h.remote = [];
    const item = mine('count-unit', { title: 'Count unit' });
    vi.mocked(api().list).mockResolvedValue([item]);
    const component = render(<PersonalCount />);
    await waitFor(() => expect(screen.getByTestId('personal-count').textContent).toBe('1'));
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    const deferred = { ...item, revision: 2, deferredUntil: new Date(Date.now() + 1000).toISOString() };
    update().mockResolvedValueOnce(deferred);
    await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 1, operation: 'later', until: deferred.deferredUntil }); });
    expect(screen.getByTestId('personal-count').textContent).toBe('0');
    await act(async () => { vi.advanceTimersByTime(1001); });
    expect(screen.getByTestId('personal-count').textContent).toBe('1');
    const next = { ...deferred, revision: 3, deferredUntil: new Date(Date.now() + 1000).toISOString() };
    update().mockResolvedValueOnce(next);
    await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 2, operation: 'later', until: next.deferredUntil }); });
    update().mockResolvedValueOnce({ ...item, revision: 4 });
    await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 3, operation: 'restore' }); });
    expect(screen.getByTestId('personal-count').textContent).toBe('1');
    update().mockResolvedValueOnce({ ...item, revision: 5 });
    await act(async () => { await updatePersonalTodo({ id: item.id, expectedRevision: 4, operation: 'delete' }); });
    expect(screen.getByTestId('personal-count').textContent).toBe('0');
    vi.mocked(api().list).mockResolvedValue([item]);
    await act(async () => { await refreshPersonalTodos(); });
    expect(screen.getByTestId('personal-count').textContent).toBe('1');
    vi.mocked(api().list).mockResolvedValue([]);
    h.generation = 2; setDataOwnerGeneration('other-test-owner', 2);
    await act(async () => { component.rerender(<PersonalCount />); });
    expect(screen.getByTestId('personal-count').textContent).toBe('0');
  });
});
