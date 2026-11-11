/**
 * The personal todo list as pure data: which view an item belongs to, tag resolution against this
 * device's catalog, filtering, grouping, in-group order, counts and the due text of a row.
 * Personal items never pass through the teammate board model; they only share its deadline buckets.
 */
import {
  createTodoDueComparator,
  todoLocalDate,
  type TeammateTodo,
  type TodoDeadline,
  type TodoPriority,
} from '@cindy/maker-shared/teammate-todo';
import type { TaskTag } from '@cindy/maker-shared';

import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
import { dayDiff } from './todoDates';
import {
  deadlineBucket,
  deadlineOverdue,
  TODO_BOARD_BUCKETS,
  weekEnd,
  type TodoBoardBucket,
  type TodoBoardView,
} from './teammateTodoBoard';

export type PersonalGrouping = 'due' | 'priority' | 'tag' | 'none';
export type PersonalOrder = 'priority' | 'due' | 'created';
export const PERSONAL_GROUPINGS: readonly PersonalGrouping[] = ['due', 'priority', 'tag', 'none'];
export const PERSONAL_ORDERS: readonly PersonalOrder[] = ['priority', 'due', 'created'];
export const DEFAULT_PERSONAL_GROUPING: PersonalGrouping = 'due';
export const DEFAULT_PERSONAL_ORDER: PersonalOrder = 'priority';
/** Highest first. */
export const PERSONAL_PRIORITIES: readonly TodoPriority[] = [3, 2, 1, 0];

export type PersonalTagFilter =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'tag'; id: string };
export const ALL_TAGS: PersonalTagFilter = { kind: 'all' };

export type PersonalSectionKey =
  | { kind: 'bucket'; bucket: TodoBoardBucket }
  | { kind: 'priority'; priority: TodoPriority }
  | { kind: 'tag'; tag: TaskTag | null }
  | { kind: 'all' };
export interface PersonalSection {
  id: string;
  key: PersonalSectionKey;
  items: PersonalTodo[];
}

export function isDeferred(todo: PersonalTodo, now: Date): boolean {
  return todo.status === 'open' && !!todo.deferredUntil && Date.parse(todo.deferredUntil) > now.getTime();
}

export function personalViewOf(todo: PersonalTodo, now: Date): TodoBoardView {
  return todo.status === 'done' ? 'done' : isDeferred(todo, now) ? 'later' : 'open';
}

export function isPersonalOpen(todo: PersonalTodo, now = new Date()): boolean {
  return personalViewOf(todo, now) === 'open';
}

/** The tag a todo shows: its first tag id that still exists in the catalog; unknown ids read as untagged. */
export function resolvePersonalTag(todo: PersonalTodo, catalog: readonly TaskTag[]): TaskTag | null {
  for (const id of todo.tagIds ?? []) {
    const tag = catalog.find((item) => item.id === id);
    if (tag) return tag;
  }
  return null;
}

/** A filter on a tag that no longer exists behaves as no filter. */
export function effectiveTagFilter(
  filter: PersonalTagFilter,
  catalog: readonly TaskTag[],
): PersonalTagFilter {
  return filter.kind === 'tag' && !catalog.some((tag) => tag.id === filter.id) ? ALL_TAGS : filter;
}

export function matchesTagFilter(
  todo: PersonalTodo,
  catalog: readonly TaskTag[],
  filter: PersonalTagFilter,
): boolean {
  if (filter.kind === 'all') return true;
  const tag = resolvePersonalTag(todo, catalog);
  return filter.kind === 'none' ? tag === null : tag?.id === filter.id;
}

export function personalCounts(items: readonly PersonalTodo[], now = new Date()) {
  const counts = { open: 0, later: 0, done: 0 };
  for (const item of items) counts[personalViewOf(item, now)]++;
  return counts;
}

export interface TagChip {
  tag: TaskTag;
  count: number;
}
/**
 * Chips under 我的待办: catalog tags (catalog order) that have open todos or are the selected
 * filter, with the open counts for 全部 and 无标签.
 */
export function personalTagChips(
  items: readonly PersonalTodo[],
  catalog: readonly TaskTag[],
  filter: PersonalTagFilter,
  now = new Date(),
) {
  const open = items.filter((item) => isPersonalOpen(item, now));
  const counts = new Map<string, number>();
  let none = 0;
  for (const item of open) {
    const tag = resolvePersonalTag(item, catalog);
    if (tag) counts.set(tag.id, (counts.get(tag.id) ?? 0) + 1);
    else none++;
  }
  const tags: TagChip[] = catalog
    .filter((tag) => (counts.get(tag.id) ?? 0) > 0 || (filter.kind === 'tag' && filter.id === tag.id))
    .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }));
  return { all: open.length, none, tags };
}

// ---------------------------------------------------------------- ordering

const compareDeadlines = (() => {
  const compare = createTodoDueComparator();
  // The comparator only reads the effective deadline; this carries it without inventing a teammate todo.
  const carrier = (deadline: TodoDeadline | null) =>
    ({ sourceDeadline: deadline }) as unknown as TeammateTodo;
  return (a: PersonalTodo, b: PersonalTodo) => compare(carrier(a.deadline), carrier(b.deadline));
})();

const newerFirst = (a: PersonalTodo, b: PersonalTodo) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
const higherPriorityFirst = (a: PersonalTodo, b: PersonalTodo) =>
  (b.priority ?? 0) - (a.priority ?? 0);

export function comparePersonalTodos(order: PersonalOrder) {
  return (a: PersonalTodo, b: PersonalTodo): number =>
    order === 'priority'
      ? higherPriorityFirst(a, b) || compareDeadlines(a, b) || newerFirst(a, b)
      : order === 'due'
        ? compareDeadlines(a, b) || higherPriorityFirst(a, b) || newerFirst(a, b)
        : newerFirst(a, b);
}

function completionTime(todo: PersonalTodo): number {
  return Date.parse(todo.completedAt ?? todo.createdAt) || 0;
}

// ---------------------------------------------------------------- sections

export interface PersonalListInput {
  items: readonly PersonalTodo[];
  view: TodoBoardView;
  grouping: PersonalGrouping;
  order: PersonalOrder;
  catalog: readonly TaskTag[];
  filter: PersonalTagFilter;
  now: Date;
}

/** Everything the list shows for a view, already filtered, ordered and grouped; empty sections are dropped. */
export function personalSections(input: PersonalListInput): PersonalSection[] {
  const { view, grouping, order, catalog, now } = input;
  const filter = effectiveTagFilter(input.filter, catalog);
  const visible = input.items.filter(
    (item) => personalViewOf(item, now) === view && matchesTagFilter(item, catalog, filter),
  );
  if (view === 'done') {
    const done = [...visible].sort((a, b) => completionTime(b) - completionTime(a) || a.id.localeCompare(b.id));
    return done.length ? [{ id: 'all', key: { kind: 'all' }, items: done }] : [];
  }
  const sorted = [...visible].sort(comparePersonalTodos(order));
  if (view === 'later' || grouping === 'none')
    return sorted.length ? [{ id: 'all', key: { kind: 'all' }, items: sorted }] : [];
  const sections: PersonalSection[] = [];
  if (grouping === 'due') {
    for (const bucket of TODO_BOARD_BUCKETS)
      sections.push({
        id: `bucket:${bucket}`,
        key: { kind: 'bucket', bucket },
        items: sorted.filter((item) => deadlineBucket(item.deadline, now) === bucket),
      });
  } else if (grouping === 'priority') {
    for (const priority of PERSONAL_PRIORITIES)
      sections.push({
        id: `priority:${priority}`,
        key: { kind: 'priority', priority },
        items: sorted.filter((item) => (item.priority ?? 0) === priority),
      });
  } else {
    for (const tag of catalog)
      sections.push({
        id: `tag:${tag.id}`,
        key: { kind: 'tag', tag },
        items: sorted.filter((item) => resolvePersonalTag(item, catalog)?.id === tag.id),
      });
    sections.push({
      id: 'tag:none',
      key: { kind: 'tag', tag: null },
      items: sorted.filter((item) => resolvePersonalTag(item, catalog) === null),
    });
  }
  return sections.filter((section) => section.items.length > 0);
}

// ---------------------------------------------------------------- due text

export interface PersonalDueOptions {
  /** Set when the list is grouped by deadline: the text then leaves out what the heading says. */
  groupBucket?: TodoBoardBucket;
  now: Date;
  locale: string;
  /** Text for a deadline that is `days` calendar days behind (0 = earlier today). */
  overdueLabel: (days: number) => string;
}

function capitalize(text: string, locale: string): string {
  return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
}

/** What the right side of a row says about the deadline; `overdue` marks the error style. */
export function personalDueText(
  deadline: TodoDeadline | null,
  { groupBucket, now, locale, overdueLabel }: PersonalDueOptions,
): { text: string; overdue: boolean } {
  if (!deadline) return { text: '', overdue: false };
  const today = todoLocalDate(now, deadline.timeZone);
  if (deadlineOverdue(deadline, now))
    return { text: overdueLabel(Math.max(0, dayDiff(today, deadline.date))), overdue: true };

  const time =
    deadline.kind === 'instant'
      ? new Intl.DateTimeFormat(locale, {
          timeZone: deadline.timeZone,
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(deadline.at!))
      : '';
  if (groupBucket === 'today') return { text: time, overdue: false };

  const ahead = dayDiff(deadline.date, today);
  const relative = (days: number) =>
    capitalize(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day'), locale);
  const weekday = () =>
    new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' }).format(
      new Date(`${deadline.date}T12:00:00Z`),
    );
  const shortDate = () =>
    new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      ...(deadline.date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}),
    }).format(new Date(`${deadline.date}T12:00:00Z`));

  let day: string;
  if (groupBucket === 'week') day = ahead === 1 ? relative(1) : weekday();
  else if (groupBucket === 'later') day = shortDate();
  else if (ahead === 0 || ahead === 1) day = relative(ahead);
  else day = deadline.date <= weekEnd(today) ? weekday() : shortDate();
  return { text: [day, time].filter(Boolean).join(' '), overdue: false };
}

// ---------------------------------------------------------------- steps

export type PersonalStep = PersonalTodo['subtasks'][number];
/** The wire shape of a checklist edit: the whole list in order, existing ids kept. */
export type PersonalStepsInput = NonNullable<PersonalTodoUpdate['subtasks']>;

/** "2/4" for a todo with steps, null for one without. */
export function stepsProgress(steps: readonly PersonalStep[]): { done: number; total: number; text: string } | null {
  if (!steps.length) return null;
  const done = steps.filter((step) => step.done).length;
  return { done, total: steps.length, text: `${done}/${steps.length}` };
}

const keep = (step: PersonalStep) => ({ id: step.id, title: step.title, done: step.done });

/** The list with one step's done state flipped. */
export function toggledSteps(steps: readonly PersonalStep[], id: string): PersonalStepsInput {
  return steps.map((step) => (step.id === id ? { ...keep(step), done: !step.done } : keep(step)));
}

/** The list without one step. */
export function removedSteps(steps: readonly PersonalStep[], id: string): PersonalStepsInput {
  return steps.filter((step) => step.id !== id).map(keep);
}

/** The list with a new step at the end; blank titles add nothing (null). */
export function appendedSteps(steps: readonly PersonalStep[], title: string): PersonalStepsInput | null {
  const trimmed = title.trim();
  return trimmed ? [...steps.map(keep), { title: trimmed }] : null;
}
