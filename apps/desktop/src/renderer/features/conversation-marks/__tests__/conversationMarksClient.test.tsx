// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：useConversationMarks / useConversationMarkSyncStatus 的真实组件订阅，
 *   和 ConversationMarkHighlights 的真实挂载；观察 conversation-marks:list / sync-status 的
 *   调用次数、订阅组件的渲染次数，以及高亮是否重建、是否观察对话 DOM。
 * - Bug 依据：标记功能上线后，标记数据没有变化时订阅组件反复调用 list 并反复重渲染
 *   （subscribe 每次渲染都是新函数 → 退订再重订 → listeners 归零又回到 1 → 再拉取 → 新快照
 *   → 再渲染），会话切换、设置页打开都卡顿，渲染进程常驻占满一个核。
 * - 现有覆盖缺口：此前标记只有 main 侧同步测试，渲染端客户端与高亮组件没有测试。
 * - 最小失败输入：一个（或同会话两个）订阅组件挂载在 list 永远返回相同内容的 API 上，
 *   空闲几轮宏任务；或给高亮组件传入内容相同的新数组 / 空数组。
 * - tier：unit（jsdom，内存假 API，不碰 IPC 与文件）。
 * - 实测耗时：单独运行约 12 秒（vitest Duration；用例本身约 3.5 秒，其余是转换、jsdom 初始化与
 *   模块收集），测于另有进程占满一个核的机器。超出预算的部分来自环境准备，用例无真实等待；
 *   同一被测模块的用例都在这一个文件里，没有拆分。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ConversationMark, ConversationMarkScope, ConversationMarkSyncStatus } from '../../../../shared/conversationMarks';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const store = vi.hoisted(() => ({
  marks: new Map<string, unknown[]>(),
  status: null as unknown,
  changed: new Set<() => void>(),
}));

/** A runaway refresh loop stalls here instead of exhausting the test worker. */
const CALL_CAP = 50;
const never = () => new Promise<never>(() => {});

const api = {
  // IPC hands back a fresh copy on every call, like structured clone does.
  list: vi.fn((scope: ConversationMarkScope) =>
    api.list.mock.calls.length > CALL_CAP
      ? never()
      : Promise.resolve(structuredClone(store.marks.get(scope.sessionId) ?? [])),
  ),
  syncStatus: vi.fn(() =>
    api.syncStatus.mock.calls.length > CALL_CAP ? never() : Promise.resolve(structuredClone(store.status)),
  ),
  update: vi.fn(),
  onChanged: (listener: () => void) => {
    store.changed.add(listener);
    return () => store.changed.delete(listener);
  },
};

beforeAll(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { localDb: { conversationMarks: api } };
});

import { ConversationMarkHighlights, MARK_HIGHLIGHT } from '../ConversationMarkHighlights';
import { toast } from '@/lib/toast';
import {
  createConversationMark,
  deleteConversationMark,
  setConversationMarkDiscussed,
  useConversationMarks,
  useConversationMarkSyncStatus,
} from '../conversationMarksClient';

function mark(sessionId: string, overrides: Partial<ConversationMark> = {}): ConversationMark {
  return {
    id: 'm1',
    revision: 1,
    sessionId,
    messageClientId: 'msg-1',
    messageCreatedAt: 1,
    authorRole: 'assistant',
    quote: 'hello',
    state: 'open',
    markedAt: 1,
    ...overrides,
  };
}

/** Lets resolved list() calls land and any resulting re-render / re-subscribe cascade play out. */
async function idle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function push(): void {
  for (const listener of store.changed) listener();
}

function listCallsFor(sessionId: string): number {
  return api.list.mock.calls.filter(([scope]) => scope.sessionId === sessionId).length;
}

function Subscriber({ sessionId, name, renders }: { sessionId: string; name: string; renders: Record<string, number> }) {
  renders[name] = (renders[name] ?? 0) + 1;
  // A new scope object on every render, as the real call sites build it inline.
  const { loaded, marks } = useConversationMarks({ sessionId, hostDeviceId: null });
  return <div data-testid={name}>{loaded ? marks.map((m) => `${m.id}:${m.state}`).join(',') || 'none' : 'loading'}</div>;
}

afterEach(() => {
  cleanup();
  api.list.mockClear();
});

describe('useConversationMarks', () => {
  it.each([
    ['one subscriber', ['a']],
    ['two subscribers of the same conversation', ['a', 'b']],
  ])('loads once and stays quiet while nothing changes (%s)', async (_label, names) => {
    const sessionId = `idle-${names.length}`;
    store.marks.set(sessionId, [mark(sessionId)]);
    const renders: Record<string, number> = {};
    const view = render(
      <>
        {names.map((name) => (
          <Subscriber key={name} sessionId={sessionId} name={name} renders={renders} />
        ))}
      </>,
    );
    await idle();
    for (const name of names) expect(screen.getByTestId(name).textContent).toBe('m1:open');
    expect(listCallsFor(sessionId)).toBe(1);
    const settled = { ...renders };

    // A parent re-render (streaming output re-renders the conversation view constantly).
    view.rerender(
      <>
        {names.map((name) => (
          <Subscriber key={name} sessionId={sessionId} name={name} renders={renders} />
        ))}
      </>,
    );
    await idle();
    expect(listCallsFor(sessionId)).toBe(1);
    for (const name of names) expect(renders[name]).toBe(settled[name] + 1);
  });

  it('keeps the newer list when an older read answers late', async () => {
    const sessionId = 'out-of-order';
    store.marks.set(sessionId, [mark(sessionId)]);
    render(<Subscriber sessionId={sessionId} name="o" renders={{}} />);
    await idle();
    const older = deferred<ConversationMark[]>();
    const newer = deferred<ConversationMark[]>();
    api.list.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    push();
    push();
    await act(async () => newer.resolve([mark(sessionId, { revision: 2, state: 'discussed' })]));
    await idle();
    await act(async () => older.resolve([mark(sessionId)]));
    await idle();
    expect(screen.getByTestId('o').textContent).toBe('m1:discussed');
  });

  it('refreshes on a change push, and ignores a push that changed nothing here', async () => {
    const sessionId = 'pushed';
    store.marks.set(sessionId, [mark(sessionId)]);
    const renders: Record<string, number> = {};
    render(<Subscriber sessionId={sessionId} name="p" renders={renders} />);
    await idle();
    const before = renders.p;

    for (const listener of store.changed) listener();
    await idle();
    expect(listCallsFor(sessionId)).toBe(2);
    expect(renders.p).toBe(before);

    store.marks.set(sessionId, [mark(sessionId, { revision: 2, state: 'discussed' })]);
    for (const listener of store.changed) listener();
    await idle();
    expect(screen.getByTestId('p').textContent).toBe('m1:discussed');
  });

  it('shows changes made while the conversation was closed, and follows a switch of conversation', async () => {
    const sessionId = 'reopened';
    store.marks.set(sessionId, [mark(sessionId)]);
    store.marks.set('other', []);
    const renders: Record<string, number> = {};
    const first = render(<Subscriber sessionId={sessionId} name="r" renders={renders} />);
    await idle();
    first.unmount();

    store.marks.set(sessionId, [mark(sessionId, { revision: 2, state: 'discussed' })]);
    for (const listener of store.changed) listener();
    const view = render(<Subscriber sessionId={sessionId} name="r" renders={renders} />);
    await idle();
    expect(screen.getByTestId('r').textContent).toBe('m1:discussed');

    view.rerender(<Subscriber sessionId="other" name="r" renders={renders} />);
    await idle();
    expect(screen.getByTestId('r').textContent).toBe('none');
  });

  it('shows a pushed change after a change made here while the conversation was closed', async () => {
    const sessionId = 'undone-away';
    const original = mark(sessionId);
    store.marks.set(sessionId, [original]);
    api.update.mockImplementation(async () => original);
    const renders: Record<string, number> = {};
    const first = render(<Subscriber sessionId={sessionId} name="u" renders={renders} />);
    await idle();
    first.unmount();
    // E.g. undo in the toast after leaving the conversation: a read with nobody watching.
    await act(() => setConversationMarkDiscussed({ sessionId, hostDeviceId: null }, original, false));
    await idle();

    store.marks.set(sessionId, [mark(sessionId, { revision: 3, state: 'discussed' })]);
    for (const listener of store.changed) listener();
    render(<Subscriber sessionId={sessionId} name="u" renders={renders} />);
    await idle();
    expect(screen.getByTestId('u').textContent).toBe('m1:discussed');
  });

  // Every action here refreshes the list itself, without waiting for the change push.
  it.each([
    ['create', [], 'm1:open', (scope: ConversationMarkScope) =>
      createConversationMark(scope, { text: 'hello', messageClientId: 'msg-1' }, { authorRole: 'assistant', messageCreatedAt: 1 })],
    ['mark discussed', ['m1:open'], 'm1:discussed', (scope: ConversationMarkScope, m: ConversationMark) =>
      setConversationMarkDiscussed(scope, m, true)],
    ['delete', ['m1:open'], 'none', (scope: ConversationMarkScope, m: ConversationMark) => deleteConversationMark(scope, m)],
    ['undo a delete', ['m1:open'], 'm1:open', async (scope: ConversationMarkScope, m: ConversationMark) => {
      await deleteConversationMark(scope, m);
      const undo = vi.mocked(toast.success).mock.calls.at(-1)?.[1] as { action: { onClick: () => void } };
      undo.action.onClick();
    }],
  ] as const)('shows the list again after a change made here (%s)', async (label, before, after, action) => {
    const sessionId = `acted-${label}`;
    const original = mark(sessionId);
    store.marks.set(sessionId, before.length ? [original] : []);
    api.update.mockImplementation(async (request: { operation?: string }) => {
      const op = request.operation;
      const next =
        op === 'discuss' ? [mark(sessionId, { revision: 2, state: 'discussed' })]
        : op === 'delete' ? []
        : [mark(sessionId, { revision: op === 'restore' ? 3 : 1 })];
      store.marks.set(sessionId, next);
      return next[0] ?? mark(sessionId, { revision: 2 });
    });
    render(<Subscriber sessionId={sessionId} name="d" renders={{}} />);
    await idle();
    expect(screen.getByTestId('d').textContent).toBe(before.length ? before[0] : 'none');
    await act(() => action({ sessionId, hostDeviceId: null }, original));
    await idle();
    expect(screen.getByTestId('d').textContent).toBe(after);
  });
});

describe('useConversationMarkSyncStatus', () => {
  it.each([
    ['sync off', null, 'off'],
    ['sync on', { phase: 'synced', pending: 0, pendingIds: [] } satisfies ConversationMarkSyncStatus, 'synced'],
  ] as const)('loads once and stays quiet while nothing changes (%s)', async (_label, value, shown) => {
    store.status = value;
    api.syncStatus.mockClear();
    let renders = 0;
    function Status() {
      renders += 1;
      const status = useConversationMarkSyncStatus();
      return <div data-testid="status">{status?.phase ?? 'off'}</div>;
    }
    const view = render(<Status />);
    await idle();
    expect(screen.getByTestId('status').textContent).toBe(shown);
    expect(api.syncStatus).toHaveBeenCalledTimes(1);
    const settled = renders;
    view.rerender(<Status />);
    await idle();
    expect(api.syncStatus).toHaveBeenCalledTimes(1);
    expect(renders).toBe(settled + 1);
  });

  it('keeps the newer status when an older read answers late', async () => {
    store.status = { phase: 'synced', pending: 0, pendingIds: [] } satisfies ConversationMarkSyncStatus;
    function Status() {
      const status = useConversationMarkSyncStatus();
      return <div data-testid="status">{status ? `${status.phase}:${status.pending}` : 'off'}</div>;
    }
    render(<Status />);
    await idle();
    const older = deferred<ConversationMarkSyncStatus | null>();
    const newer = deferred<ConversationMarkSyncStatus | null>();
    api.syncStatus.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    push();
    push();
    await act(async () => newer.resolve({ phase: 'syncing', pending: 1, pendingIds: ['m1'] }));
    await idle();
    await act(async () => older.resolve({ phase: 'synced', pending: 0, pendingIds: [] }));
    await idle();
    expect(screen.getByTestId('status').textContent).toBe('syncing:1');
  });
});

describe('ConversationMarkHighlights', () => {
  function Harness({ marks }: { marks: ConversationMark[] }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div ref={ref}>
        <div data-message-client-id="msg-1">say hello there</div>
        <ConversationMarkHighlights containerRef={ref} marks={marks} />
      </div>
    );
  }

  function stubHighlightApi() {
    const registry = new Map<string, unknown>();
    let built = 0;
    class FakeHighlight extends Set<Range> {
      constructor() {
        super();
        built += 1;
      }
    }
    vi.stubGlobal('Highlight', FakeHighlight);
    vi.stubGlobal('CSS', { highlights: registry, escape: (value: string) => value });
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    restoreObserve = () => observe.mockRestore();
    return { registry, built: () => built, observe };
  }

  let restoreObserve = () => {};
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreObserve();
  });

  it('keeps its highlights when handed equivalent marks', async () => {
    const highlight = stubHighlightApi();
    const view = render(<Harness marks={[mark('h')]} />);
    expect(highlight.built()).toBe(2);
    expect((highlight.registry.get(MARK_HIGHLIGHT) as Set<Range>).size).toBe(1);

    view.rerender(<Harness marks={[mark('h')]} />);
    expect(highlight.built()).toBe(2);

    view.rerender(<Harness marks={[mark('h', { revision: 2, state: 'discussed' })]} />);
    expect(highlight.built()).toBe(4);
  });

  it('does not watch the conversation while there are no marks', async () => {
    const highlight = stubHighlightApi();
    const view = render(<Harness marks={[]} />);
    expect(highlight.observe).not.toHaveBeenCalled();

    view.rerender(<Harness marks={[mark('h')]} />);
    expect(highlight.observe).toHaveBeenCalledTimes(1);

    view.rerender(<Harness marks={[]} />);
    expect(highlight.registry.has(MARK_HIGHLIGHT)).toBe(false);
  });
});
