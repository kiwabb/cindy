/**
 * 「待办」页：个人待办按截止分段的口径。个人事项适配成 `TeammateTodo` 形状后复用同一套截止判定与排序。
 */
import {
  effectiveTodoDeadline,
  todoLocalDate,
  todoOverdue,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';

import type { PersonalTodo } from '../../../shared/personalTodo';

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
  personal: PersonalTodo;
  /** 个人事项适配成的待办形状，只用于截止分段与排序。 */
  todo: TeammateTodo;
}

export type TodoBoardView = 'open' | 'later' | 'done';

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
