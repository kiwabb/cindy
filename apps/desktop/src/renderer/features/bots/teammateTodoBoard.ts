/**
 * 「待办」页：把各位伙伴（本机与别的电脑上的）各自的待办合成一张只读清单。
 *
 * 数据仍来自每位伙伴自己的宿主（`botGlanceTodos` 那条读取路径），这里只做合并、按截止分段与筛选。
 * 结果按伙伴暂存在内存里：那台电脑离线后，上次读到的仍可置灰显示；换账号时整份丢弃。
 */
import {
  createTodoDueComparator,
  effectiveTodoDeadline,
  todoLocalDate,
  todoOverdue,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { GlanceTodoHost, GlanceTodos } from './botGlanceTodos';

/** 待办页上的一位伙伴：本机伙伴没有 deviceId。 */
export interface TodoBoardTeammate extends GlanceTodoHost {
  /** 本机唯一键（同一伙伴在不同电脑上各有一份待办）。 */
  key: string;
  name: string;
  avatar?: string | null;
  avatarColor?: string | null;
  /** 别的电脑上的伙伴所在电脑的名字。 */
  deviceName?: string;
  /** 那台电脑确定离线；离线时不去读，只显示上次读到的。 */
  offline: boolean;
  /** 点一条待办时打开的伙伴对话。 */
  route: string;
}

export function todoBoardKey(host: GlanceTodoHost): string {
  return host.deviceId ? `${host.deviceId}\u0000${host.botId}` : host.botId;
}

export type TodoBoardBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
export const TODO_BOARD_BUCKETS: readonly TodoBoardBucket[] = ['overdue', 'today', 'week', 'later', 'none'];

/** 本周最后一天（周日）；周一为一周第一天。 */
function weekEnd(localDate: string): string {
  const date = new Date(localDate + 'T00:00:00Z');
  const toSunday = (7 - date.getUTCDay()) % 7;
  date.setUTCDate(date.getUTCDate() + toSunday);
  return date.toISOString().slice(0, 10);
}

/**
 * 按自己的截止分段，日期都按截止所在时区算。只有建议日期或待确认期限的事项归「无截止」：
 * 建议不制造紧迫感（与近况口径一致）。
 */
export function todoBoardBucket(todo: TeammateTodo, now = new Date()): TodoBoardBucket {
  const deadline = effectiveTodoDeadline(todo);
  if (!deadline) return 'none';
  if (todoOverdue(todo, now)) return 'overdue';
  const today = todoLocalDate(now, deadline.timeZone);
  if (deadline.date === today) return 'today';
  return deadline.date <= weekEnd(today) ? 'week' : 'later';
}

export interface TodoBoardItem {
  personal?: import('../../../shared/personalTodo').PersonalTodo;
  todo: TeammateTodo;
  teammate: TodoBoardTeammate;
}

export type TodoBoardOrigin = 'all' | 'assigned' | 'discovered';
export type TodoBoardView = 'open' | 'later' | 'done';

export interface TodoBoardFilter {
  /** 空集合表示全部伙伴。 */
  teammates: ReadonlySet<string>;
  origin: TodoBoardOrigin;
}

export interface TodoBoardEntry {
  todos: GlanceTodos;
  failed: boolean;
}

function matches(item: TodoBoardItem, filter: TodoBoardFilter): boolean {
  if (filter.teammates.size > 0 && !filter.teammates.has(item.teammate.key)) return false;
  return filter.origin === 'all' || item.todo.origin === filter.origin;
}

function completedAt(todo: TeammateTodo): number {
  const last = todo.history[todo.history.length - 1];
  return Date.parse(last?.at ?? todo.updatedAt) || 0;
}

/** 合并各位伙伴的一类待办并排序：进行中与稍后再说按截止，已完成按完成时间倒序。 */
export function todoBoardItems(
  teammates: readonly TodoBoardTeammate[],
  entries: ReadonlyMap<string, TodoBoardEntry>,
  view: TodoBoardView,
  filter: TodoBoardFilter,
): TodoBoardItem[] {
  const items: TodoBoardItem[] = [];
  for (const teammate of teammates) {
    const todos = entries.get(teammate.key)?.todos;
    if (!todos) continue;
    const list = view === 'open' ? todos.open : view === 'later' ? todos.later : todos.done;
    for (const todo of list) {
      const item = { todo, teammate };
      if (matches(item, filter)) items.push(item);
    }
  }
  if (view === 'done') return items.sort((a, b) => completedAt(b.todo) - completedAt(a.todo));
  const compareDue = createTodoDueComparator();
  return items.sort((a, b) =>
    compareDue(a.todo, b.todo) ||
    (view === 'later' ? (Date.parse(a.todo.decision?.until ?? '') || 0) - (Date.parse(b.todo.decision?.until ?? '') || 0) : 0) ||
    a.todo.createdAt.localeCompare(b.todo.createdAt) ||
    a.teammate.key.localeCompare(b.teammate.key) ||
    a.todo.id.localeCompare(b.todo.id));
}

/** 已按截止排好的事项分进各段；空段不返回。 */
export function groupTodoBoardItems(
  items: readonly TodoBoardItem[],
  now = new Date(),
): Array<{ bucket: TodoBoardBucket; items: TodoBoardItem[] }> {
  const groups = new Map<TodoBoardBucket, TodoBoardItem[]>();
  for (const item of items) {
    const bucket = todoBoardBucket(item.todo, now);
    groups.set(bucket, [...(groups.get(bucket) ?? []), item]);
  }
  return TODO_BOARD_BUCKETS.filter((bucket) => groups.has(bucket)).map((bucket) => ({ bucket, items: groups.get(bucket)! }));
}

/** 侧栏「待办」入口上的数：读到的各位伙伴进行中的待办。 */
export function todoBoardOpenCount(teammates: readonly TodoBoardTeammate[], entries: ReadonlyMap<string, TodoBoardEntry>): number {
  return teammates.reduce((sum, teammate) => sum + (entries.get(teammate.key)?.todos.open.length ?? 0), 0);
}

// ---------------------------------------------------------------- 内存暂存

let owner: DataOwnerGeneration = getDataOwnerGeneration();
let entries = new Map<string, TodoBoardEntry>();
/** 同一位伙伴只由一处读取（侧栏与待办页都挂着时不重复读）；排在最前的那处负责读。 */
let readers = new Map<string, symbol[]>();
/** 负责读取的那处登记的重读入口，供「重试」用。 */
const refreshers = new Map<string, () => void>();
const listeners = new Set<() => void>();

function current(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  entries = new Map();
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeTodoBoard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTodoBoardEntries(): ReadonlyMap<string, TodoBoardEntry> {
  current();
  return entries;
}

/** 写入一位伙伴最新读到的待办；读取失败时保留上次读到的内容。 */
export function setTodoBoardEntry(key: string, generation: DataOwnerGeneration, next: { todos?: GlanceTodos; failed: boolean }): void {
  current();
  if (!isDataOwnerGenerationCurrent(generation)) return;
  const previous = entries.get(key);
  const todos = next.todos ?? previous?.todos;
  if (!todos) {
    if (previous?.failed === next.failed) return;
    entries = new Map(entries).set(key, { todos: { open: [], openTotal: 0, done: [], doneTotal: 0, nextDeferredAt: null, dailyCheck: null, later: [] }, failed: next.failed });
  } else {
    entries = new Map(entries).set(key, { todos, failed: next.failed });
  }
  emit();
}

/** 只有读过（成功或失败）的伙伴才在暂存里；没读过的不算 0 条。 */
export function hasTodoBoardEntry(key: string): boolean {
  current();
  return entries.has(key);
}

export function claimTodoBoardReader(key: string, token: symbol): () => void {
  readers = new Map(readers).set(key, [...(readers.get(key) ?? []), token]);
  emit();
  return () => {
    const rest = (readers.get(key) ?? []).filter((item) => item !== token);
    readers = new Map(readers);
    if (rest.length) readers.set(key, rest);
    else readers.delete(key);
    emit();
  };
}

export function isTodoBoardReader(key: string, token: symbol): boolean {
  return readers.get(key)?.[0] === token;
}

export function setTodoBoardRefresh(key: string, refresh: (() => void) | null): void {
  if (refresh) refreshers.set(key, refresh);
  else refreshers.delete(key);
}

export function refreshTodoBoardEntry(key: string): void {
  refreshers.get(key)?.();
}

export const __testing = {
  reset(): void {
    owner = getDataOwnerGeneration();
    entries = new Map();
    readers = new Map();
    refreshers.clear();
    listeners.clear();
  },
};
