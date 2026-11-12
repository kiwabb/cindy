import { createHash, randomUUID } from 'node:crypto';
import { TodoError, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import type { TaskTag } from '@cindy/maker-shared';
import type { PersonalTodoUpdate } from '../../shared/personalTodo.js';
import {
  onSharedDatasetChanged,
  registerSharedDataset,
  type SharedDatasetDefinition,
  type SharedItem,
  type SharedUpdate,
} from '../shared-datasets/api.js';
import {
  listLocalTaskTagCatalog,
  notifyPersonalTodosChanged,
  onPersonalTodosChanged,
  openPersonalTodoStore,
  PERSONAL_TODOS_DATASET_ID,
  PersonalTodoOwnerChangedError,
} from './personalTodoAccess.js';

type StoredTodo = TeammateTodo & SharedItem;

/**
 * Stored shape version of the raw items. Peers with another version do not join each other; bump
 * it when a peer on the previous version could not read, or would corrupt, what this one stores.
 * An optional field the previous version passes through on read and drops on its own writes is
 * not such a change (`subtasks[].doneAt`: an older home simply records no step times).
 */
export const PERSONAL_TODOS_SCHEMA_VERSION = 1;

/**
 * Private markers on a carried-over creation (join / demotion) of an already completed or deferred
 * todo: a creation carries no state, so `applySubmit` applies it right after creating (not store fields).
 */
const CARRY_DONE = 'carryDone';
const CARRY_LATER = 'carryLater';

const deadlineOf = (todo: TeammateTodo) => todo.deadlineOverride?.value ?? todo.sourceDeadline;

/**
 * The checklist as a whole-list replacement (ids kept, so a retried or revised edit does not
 * duplicate steps; completion times kept, so the home records when a step was checked here).
 */
const stepsOf = (todo: TeammateTodo) =>
  (todo.subtasks ?? []).map(({ id, title, done, doneAt }) => ({
    id,
    title,
    done,
    ...(doneAt ? { doneAt } : {}),
  }));

const deferral = (todo: TeammateTodo) => (todo.decision?.kind === 'later' ? (todo.decision.until ?? null) : null);

/** The state change (done / reopened / deferred / resumed) that takes `remote` to `local`, if any. */
function revisionOperation(local: TeammateTodo, remote: TeammateTodo): Partial<PersonalTodoUpdate> {
  if (local.status !== remote.status) return { operation: local.status === 'done' ? 'complete' : 'reopen' };
  if (local.status === 'done') return {};
  const until = deferral(local);
  if (until && until !== deferral(remote) && Date.parse(until) > Date.now()) return { operation: 'later', until };
  if (!until && deferral(remote)) return { operation: 'restore' };
  return {};
}

/**
 * Personal todos as a shared dataset. Items are the raw stored todos (the same file every reader
 * uses, so on a replica the file is the mirror), extras are this computer's tag catalog, and the
 * authoritative write is the ordinary `store.update` with its PersonalTodoUpdate validation.
 */
export const personalTodosDataset: SharedDatasetDefinition<StoredTodo, TaskTag[]> = {
  id: PERSONAL_TODOS_DATASET_ID,
  schemaVersion: PERSONAL_TODOS_SCHEMA_VERSION,
  async readItems() {
    const { store, assertCurrent } = openPersonalTodoStore();
    const state = await store.read();
    assertCurrent();
    return state.items as StoredTodo[];
  },
  async readExtras() {
    try {
      return await listLocalTaskTagCatalog();
    } catch {
      // Without a catalog the replica shows its tags as untagged; the todos still sync.
      return undefined;
    }
  },
  cursorOf(items, extras) {
    return createHash('sha256')
      .update(JSON.stringify([items, extras ?? null]))
      .digest('hex')
      .slice(0, 32);
  },
  async replaceMirror(items, removeIds) {
    const { store, assertCurrent } = openPersonalTodoStore();
    await store.importItems(items, removeIds);
    assertCurrent();
  },
  async applySubmit(update: SharedUpdate) {
    const { [CARRY_DONE]: carryDone, [CARRY_LATER]: carryLater, ...plain } = update;
    const { store, assertCurrent } = openPersonalTodoStore();
    let todo = await store.update(plain as PersonalTodoUpdate);
    if (carryDone === true && todo.status !== 'done') {
      todo = await store.update({ id: todo.id, expectedRevision: todo.revision, operation: 'complete' });
    } else if (
      typeof carryLater === 'string' &&
      todo.status === 'open' &&
      todo.deferredUntil !== carryLater &&
      Date.parse(carryLater) > Date.now()
    ) {
      // A deferral that already ended while the computer was away is simply an open todo again.
      todo = await store.update({
        id: todo.id,
        expectedRevision: todo.revision,
        operation: 'later',
        until: carryLater,
      });
    }
    assertCurrent();
    return todo;
  },
  onLocalChange: (callback) => onPersonalTodosChanged(() => callback()),
  errorCode: (error) => (error instanceof TodoError ? error.code : null),
  creationUpdate(item, requestId) {
    if (item.decision?.kind === 'deleted') return null;
    return {
      creationRequestId: requestId,
      title: item.title,
      notes: item.progress,
      deadline: deadlineOf(item),
      ...(item.priority ? { priority: item.priority } : {}),
      ...(item.tagIds?.length ? { tagIds: item.tagIds } : {}),
      ...(item.reminder && item.reminder !== 'default' ? { reminder: item.reminder } : {}),
      ...(item.subtasks?.length ? { subtasks: stepsOf(item) } : {}),
      ...(item.status === 'done' ? { [CARRY_DONE]: true } : {}),
      ...(item.status === 'open' && item.decision?.kind === 'later' && item.decision.until
        ? { [CARRY_LATER]: item.decision.until }
        : {}),
    };
  },
  renewCreation: (update) => ({ ...update, creationRequestId: `retry-${randomUUID()}` }),
  reviseUpdate(local, remote) {
    if (local.decision?.kind === 'deleted') return remote.decision?.kind === 'deleted' ? null : { operation: 'delete' };
    if (remote.decision?.kind === 'deleted') return null;
    return {
      title: local.title,
      notes: local.progress,
      deadline: deadlineOf(local),
      priority: local.priority ?? 0,
      tagIds: local.tagIds ?? [],
      reminder: local.reminder ?? 'default',
      subtasks: stepsOf(local),
      ...revisionOperation(local, remote),
    };
  },
};

let registered = false;

/**
 * Registers the dataset and bridges the sync layer to every reader of personal todos: a mirror
 * or home change made by sync (not by a local write) re-announces through the one change
 * notification, so the UI, phone resource and reminders refresh and re-read the role.
 */
export function registerPersonalTodoSharedDataset(): void {
  if (registered) return;
  registered = true;
  registerSharedDataset(personalTodosDataset);
  onSharedDatasetChanged((id) => {
    if (id !== PERSONAL_TODOS_DATASET_ID) return;
    try {
      notifyPersonalTodosChanged();
    } catch (error) {
      if (!(error instanceof PersonalTodoOwnerChangedError)) throw error;
    }
  });
}
