// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：「待办」页（TeammateTodosView，路由 /bots/todos）。主人看到的分段与顺序、
 *   稍后再说与已完成不混进进行中、伙伴与状态筛选、点一条打开那位伙伴的对话；离线电脑上的伙伴不去读，
 *   读到过的置灰保留，读失败给重试。
 * - Bug／规则依据：2026-11-06 主人确认的待办面板原型（单列表按截止分段、只读、离线整行置灰）；
 *   docs/product-rules/cindy-bots-runtime.md §6.3.6「伙伴 Todo」的待办页段落。
 * - 现有覆盖缺口：新页面；近况测试只覆盖单个伙伴、且只列 7 天内到期的。
 * - 最小失败输入：本机伙伴 + 在线远程伙伴 + 离线远程伙伴，各段各一条，外加一条稍后再说与一条已完成。
 * - tier：unit（jsdom 渲染真实页面与真实读取路径，宿主与 device-link 用内存 fake）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryTodoItems, type TeammateTodo, type TodoListQuery } from '@cindy/maker-shared/teammate-todo';

const h = vi.hoisted(() => ({
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
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));
vi.mock('../BotGlancePopover', () => ({ TodoDueDot: () => <span data-testid="due-dot" /> }));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.local }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => h.remote }));
vi.mock('../companionCloudStore', () => ({
  useCompanionCloud: () => ({ enabled: false, selfDeviceId: null, actors: [], demotedBotIds: [] }),
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

let localItems: TeammateTodo[] = [];
let remoteItems: TeammateTodo[] = [];
let remoteFails = false;
const invoke = vi.fn(async (_deviceId: string, _channel: string, [request]: [{ query: string }]) => {
  if (remoteFails) throw new Error('offline');
  return { blocks: [{ primitive: 'teammate-todos', data: queryTodoItems(remoteItems, JSON.parse(request.query) as TodoListQuery) }] };
});

beforeEach(() => {
  // 2026-11-06 是周五；本周到 11-08 周日为止。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T02:30:00Z'));
  __testing.reset();
  remoteFails = false;
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
    localDb: { bots: { todos: { list: async () => ({ items: localItems, version: 1 }), dailyCheck: vi.fn() } } },
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

    // 已完成折叠在底部。
    fireEvent.click(screen.getByText('bots.glance.doneCount:1'));
    expect(rowTitles()).toContain('交 OKR 自评');

    // 稍后再说单独一档，带再提醒的日期；不再提示的哪里都不出现。
    fireEvent.click(screen.getByRole('radio', { name: 'bots.todoBoard.view.later' }));
    expect(rowTitles()).toEqual(['换办公椅']);
    expect(screen.getByText(/^bots\.todoBoard\.laterUntil:/)).toBeTruthy();
    expect(screen.queryByText('不再提示的')).toBeNull();

    // 按伙伴筛选，点一条打开那位伙伴在它电脑上的对话。
    fireEvent.click(screen.getByRole('radio', { name: 'bots.todoBoard.view.open' }));
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
    __testing.reset();
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
