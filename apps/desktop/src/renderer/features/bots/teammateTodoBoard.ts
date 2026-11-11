/**
 * 「待办」页：个人待办按截止分段的口径。日期都按截止所在时区算。
 */
import { todoLocalDate, type TodoDeadline } from '@cindy/maker-shared/teammate-todo';

export type TodoBoardBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
export const TODO_BOARD_BUCKETS: readonly TodoBoardBucket[] = ['overdue', 'today', 'week', 'later', 'none'];
export type TodoBoardView = 'open' | 'later' | 'done';

/** 本周最后一天（周日）；周一为一周第一天。 */
export function weekEnd(localDate: string): string {
  const date = new Date(localDate + 'T00:00:00Z');
  const toSunday = (7 - date.getUTCDay()) % 7;
  date.setUTCDate(date.getUTCDate() + toSunday);
  return date.toISOString().slice(0, 10);
}

/** 截止已过：时刻在现在之前，或日期早于截止所在时区的今天。 */
export function deadlineOverdue(deadline: TodoDeadline, now = new Date()): boolean {
  return deadline.kind === 'instant'
    ? Date.parse(deadline.at!) < now.getTime()
    : deadline.date < todoLocalDate(now, deadline.timeZone);
}

/** 截止分段本身；没有截止（含只有建议日期的）归「无截止」，建议不制造紧迫感。 */
export function deadlineBucket(deadline: TodoDeadline | null, now = new Date()): TodoBoardBucket {
  if (!deadline) return 'none';
  if (deadlineOverdue(deadline, now)) return 'overdue';
  const today = todoLocalDate(now, deadline.timeZone);
  if (deadline.date === today) return 'today';
  return deadline.date <= weekEnd(today) ? 'week' : 'later';
}
