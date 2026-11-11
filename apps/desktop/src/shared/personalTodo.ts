import type {
  TeammateTodo,
  TodoDeadline,
  TodoPriority,
  TodoReminder,
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
    ownership: 'self',
    source: 'manual',
  };
}
