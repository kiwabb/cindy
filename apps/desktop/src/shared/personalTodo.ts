import {
  TodoError,
  validTodoRank,
  type TeammateTodo,
  type TodoDeadline,
  type TodoLink,
  type TodoPriority,
  type TodoReminder,
  type TodoSubtask,
} from '@cindy/maker-shared/teammate-todo';

/** Personal ownership is established by the account store, never by teammate origin. */
export interface PersonalTodo {
  id: string;
  revision: number;
  title: string;
  notes: string;
  deadline: TodoDeadline | null;
  status: 'open' | 'done';
  deferredUntil: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  creationRequestId?: string;
  /** 0 none, 1 low, 2 medium, 3 high. */
  priority: TodoPriority;
  /** Ids in this device's task-tag catalog; an id missing from the catalog reads as untagged. */
  tagIds: string[];
  reminder: TodoReminder;
  /** Ordered checklist steps: a title, a done state and, once checked, when (`doneAt`). */
  subtasks: TodoSubtask[];
  /** The conversation this todo opens (e.g. a tutor's study conversation); absent means none. */
  link?: TodoLink;
  /**
   * Manual order, lower first (see `comparePersonalTodoRank`). A todo never placed by hand reads
   * as its creation time in milliseconds, so it sits in creation order among the placed ones.
   */
  rank: number;
  ownership: 'self';
  source: 'manual';
}
export interface PersonalTodoUpdate {
  id?: string;
  creationRequestId?: string;
  expectedRevision?: number;
  title?: string;
  notes?: string;
  deadline?: TodoDeadline | null;
  priority?: TodoPriority;
  tagIds?: string[];
  reminder?: TodoReminder;
  /**
   * Replaces the whole checklist in this order, guarded by expectedRevision like every edit.
   * Keep the ids of existing steps; a new step may omit its id and `done` (false). `doneAt` is
   * optional: a step already checked keeps its time and a newly checked one gets the time of the edit.
   */
  subtasks?: Array<{ id?: string; title: string; done?: boolean; doneAt?: string }>;
  /** Links the todo to a conversation; null removes the link. Send it only to change it. */
  link?: TodoLink | null;
  /**
   * Absolute manual rank, always resolved on this computer from a `place` before the edit is
   * written or queued for the main computer. Send it only to move a todo: a main computer from
   * before manual order refuses the field.
   */
  rank?: number | null;
  operation?: 'complete' | 'reopen' | 'delete' | 'later' | 'restore';
  until?: string;
}
export const PERSONAL_TODO_UPDATE_KEYS = [
  'id',
  'creationRequestId',
  'expectedRevision',
  'title',
  'notes',
  'deadline',
  'priority',
  'tagIds',
  'reminder',
  'subtasks',
  'link',
  'rank',
  'operation',
  'until',
] as const satisfies ReadonlyArray<keyof PersonalTodoUpdate>;
export function projectPersonalTodo(todo: TeammateTodo): PersonalTodo {
  return {
    id: todo.id,
    revision: todo.revision,
    title: todo.title,
    notes: todo.progress,
    deadline: todo.deadlineOverride?.value ?? todo.sourceDeadline,
    status: todo.status,
    deferredUntil: todo.decision?.kind === 'later' ? (todo.decision.until ?? null) : null,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    completedAt: todo.status === 'done' ? (todo.history.at(-1)?.at ?? null) : null,
    creationRequestId: todo.key.startsWith('personal:') ? todo.key.slice(9) : undefined,
    priority: todo.priority ?? 0,
    tagIds: todo.tagIds ?? [],
    reminder: todo.reminder ?? 'default',
    subtasks: todo.subtasks ?? [],
    ...(todo.link ? { link: todo.link } : {}),
    rank: effectiveTodoRank(todo),
    ownership: 'self',
    source: 'manual',
  };
}

/** The stored manual rank, or the creation time for a todo never placed by hand. */
export function effectiveTodoRank(todo: Pick<TeammateTodo, 'rank' | 'createdAt'>): number {
  return validTodoRank(todo.rank) ? todo.rank : Date.parse(todo.createdAt) || 0;
}

/** Manual order: rank, then creation time, then id, so every computer shows the same order. */
export function comparePersonalTodoRank(
  a: Pick<PersonalTodo, 'rank' | 'createdAt' | 'id'>,
  b: Pick<PersonalTodo, 'rank' | 'createdAt' | 'id'>,
): number {
  return a.rank - b.rank || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Where todos go in the manual order: at the top or bottom of the whole list, or right before or
 * after another todo. Resolved to absolute ranks on this computer (`planPersonalTodoOrder`).
 */
export type PersonalTodoPlace = { to: 'top' | 'bottom' } | { before: string } | { after: string };

/** A write from a local surface: the update plus, optionally, where the todo goes. */
export type PersonalTodoWriteRequest = PersonalTodoUpdate & { place?: PersonalTodoPlace };

/** A shape check that names the problem; ids are checked against the list by the planner. */
export function normalizePersonalTodoPlace(value: unknown): PersonalTodoPlace {
  const fail = () => {
    throw new TodoError(
      'INVALID_INPUT',
      "INVALID_INPUT: place must be {to:'top'|'bottom'}, {before:id} or {after:id}",
    );
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return fail();
  const [key, target] = entries[0];
  if (key === 'to' && (target === 'top' || target === 'bottom')) return { to: target };
  if ((key === 'before' || key === 'after') && typeof target === 'string' && target && target.length <= 512)
    return key === 'before' ? { before: target } : { after: target };
  return fail();
}

/** Spacing between neighbouring ranks the planner hands out: one second on the creation scale. */
const RANK_STEP = 1000;

type Ranked = Pick<PersonalTodo, 'id' | 'rank' | 'createdAt'>;

/**
 * The rank changes that put `ids` (in this order, as one block) at `place`; without a place the
 * block starts where the first of them currently is. Only the moved todos change, spread between
 * their new neighbours; when no room is left between those (equal ranks, or a gap worn down by
 * many moves) every todo is renumbered in the new order. An order that already holds returns [].
 */
export function planPersonalTodoOrder(
  items: readonly Ranked[],
  ids: readonly string[],
  place?: PersonalTodoPlace,
): Array<{ id: string; rank: number }> {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new TodoError('INVALID_INPUT', 'INVALID_INPUT: ids must be a non-empty list without repeats');
  const order = [...items].sort(comparePersonalTodoRank);
  const byId = new Map(order.map((item) => [item.id, item]));
  const moving = ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new TodoError('NOT_FOUND');
    return item;
  });
  const moved = new Set(ids);
  const rest = order.filter((item) => !moved.has(item.id));
  let index: number;
  if (!place) index = order.findIndex((item) => moved.has(item.id));
  else if ('to' in place) index = place.to === 'top' ? 0 : rest.length;
  else {
    const anchor = 'before' in place ? place.before : place.after;
    if (moved.has(anchor))
      throw new TodoError('INVALID_INPUT', 'INVALID_INPUT: place must name a todo that is not being moved');
    const at = rest.findIndex((item) => item.id === anchor);
    if (at < 0) throw new TodoError('NOT_FOUND');
    index = 'before' in place ? at : at + 1;
  }
  const next = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  if (next.every((item, i) => item.id === order[i].id)) return [];
  const low = rest[index - 1]?.rank;
  const high = rest[index]?.rank;
  const k = moving.length;
  const ranks = moving.map((item, i) =>
    low === undefined && high === undefined
      ? moving[0].rank + i * RANK_STEP
      : low === undefined
        ? high! - (k - i) * RANK_STEP
        : high === undefined
          ? low + (i + 1) * RANK_STEP
          : low + ((high - low) * (i + 1)) / (k + 1),
  );
  const fits = ranks.every(
    (rank, i) =>
      validTodoRank(rank) &&
      (i === 0 ? low === undefined || rank > low : rank > ranks[i - 1]) &&
      (i < k - 1 || high === undefined || rank < high),
  );
  if (fits) return moving.map((item, i) => ({ id: item.id, rank: ranks[i] }));
  return next
    .map((item, i) => ({ id: item.id, rank: i * RANK_STEP, before: item.rank }))
    .filter((change) => change.rank !== change.before)
    .map(({ id, rank }) => ({ id, rank }));
}

/** Multi-computer sync of personal todos as the desktop page sees it. */
export interface PersonalTodoSyncStatus {
  role: 'off' | 'home' | 'replica';
  homeName?: string;
  homeOnline: boolean;
  /** Edits made here that the main computer has not accepted yet. */
  pending: number;
  conflicts: number;
  lastSyncedAt?: number;
  /** The last sync attempt failed with this code (e.g. `REMOTE_DISABLED` = main computer has remote control off). */
  lastError?: string;
  /** Replica only: the main computer's tag catalog, which the tag picker uses. */
  tags?: import('@cindy/maker-shared').TaskTag[];
}

/** An edit made here that the main computer refused (it was changed there first). */
export interface PersonalTodoSyncConflict {
  /** Stable id of the refused edit; resolve by it. */
  id: string;
  /** Why the main computer refused it (e.g. `CONFLICT`, `NOT_FOUND`). */
  code: string;
  /** The todo the edit was about; absent for a creation that never reached the main computer. */
  todoId?: string;
  /** A refused creation: the todo as drafted here, since the main computer never stored it. */
  draft?: PersonalTodoUpdate;
}

export type PersonalTodoSyncChoice = 'mine' | 'theirs';
