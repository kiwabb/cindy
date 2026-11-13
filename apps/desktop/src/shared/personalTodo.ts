import type {
  TeammateTodo,
  TodoDeadline,
  TodoLink,
  TodoPriority,
  TodoReminder,
  TodoSubtask,
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
    ownership: 'self',
    source: 'manual',
  };
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
