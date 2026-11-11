/**
 * 个人待办的手机远程资源：经通用 Remote Resource 协议读写本机账号文件里的个人待办。
 *
 * - 集合 `personal-todos`（placement `hidden`，不进手机首页）只有一个资源 `todos:me`，
 *   块原语 `personal-todos`：只投影用户可见字段（显式白名单），不发 creationRequestId、
 *   来源、历史、动作等宿主内部字段；
 * - 动作 `update`：与桌面 IPC 同一份 `PersonalTodoUpdate`（新建/改标题备注日期/完成/重开/删除/稍后/恢复），
 *   经 `openPersonalTodoStore` 写本机文件，成功后 `notifyPersonalTodosChanged`，
 *   桌面界面、Agent 工具与手机的写入都经它让其他控制端重读；
 * - 账号边界：每次读写前后都核对数据属主，换账号后不返回、不写入、不广播。
 */
import { createHash } from 'node:crypto';
import { REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import type { TaskTag } from '@cindy/maker-shared';
import {
  TODO_REMINDERS,
  TodoError,
  type TodoDeadline,
  type TodoPriority,
  type TodoReminder,
} from '@cindy/maker-shared/teammate-todo';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import {
  remoteResourceRegistry,
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../../device-link/remoteResourceRegistry.js';
import {
  notifyPersonalTodosChanged,
  onPersonalTodosChanged,
  openPersonalTodoStore,
  listPersonalTodoTagCatalog,
  PersonalTodoOwnerChangedError,
} from '../../maker-ipc/personalTodoAccess.js';
import { onTaskTagCatalogChanged } from './taskTagChanges.js';

export const PERSONAL_TODOS_COLLECTION = 'personal-todos';
export const PERSONAL_TODOS_PRIMITIVE = 'personal-todos';
const KIND = 'personal-todos';
const RESOURCE_ID = 'todos:me';
const MAX_ITEMS = 500;
const MAX_FALLBACK_CHARS = 8000;
const UPDATE_KEYS = [
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
] as const;
/**
 * Advertised in the block data. The released desktop (r3) rejects unknown update fields, so a phone
 * sends `priority` / `tagIds` / `reminder` only when the host lists `organize` here.
 */
export const PERSONAL_TODO_REMOTE_CAPABILITIES = { organize: 1 } as const;
const OPERATIONS = ['complete', 'reopen', 'delete', 'later', 'restore'];

const resourceRef = { collectionId: PERSONAL_TODOS_COLLECTION, kind: KIND, id: RESOURCE_ID } as const;
const title = {
  fallback: 'Todos',
  translations: {
    'zh-CN': '待办',
    'zh-TW': '待辦',
    ja: 'Todo',
    ko: '할 일',
    es: 'Tareas pendientes',
    fr: 'Tâches à faire',
    de: 'Aufgaben',
    'pt-PT': 'Tarefas',
    'pt-BR': 'Tarefas',
    'zh-Hant-x-lzh': '待辦',
    'zh-Hans-x-lzh': '待办',
  },
};

const changedAccount = () => new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');

/** Tag as the phone sees it: catalog-resolved, `nameCustomized` only when true so presets localize on the phone. */
export interface PersonalTodoRemoteTag {
  id: string;
  name: string;
  color: TaskTag['color'];
  nameCustomized?: true;
}

/** A catalog read failure must not fail the todo read: every item then reads as untagged. */
async function readTagCatalog(): Promise<Map<string, TaskTag>> {
  try {
    return new Map((await listPersonalTodoTagCatalog()).map((tag) => [tag.id, tag]));
  } catch {
    return new Map();
  }
}

function resolveTags(todo: PersonalTodo, catalog: Map<string, TaskTag>): PersonalTodoRemoteTag[] {
  const tags: PersonalTodoRemoteTag[] = [];
  for (const id of todo.tagIds ?? []) {
    const tag = catalog.get(id);
    if (!tag) continue;
    tags.push({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      ...(tag.nameCustomized ? { nameCustomized: true as const } : {}),
    });
  }
  return tags;
}

/**
 * Explicit allowlist: new PersonalTodo fields stay on the host until they are added here on purpose.
 * `tagIds` stays off the wire: the phone only needs the resolved tags, and an id the catalog no longer
 * has must read as untagged there too.
 */
export function personalTodoRemoteProjection(
  todo: PersonalTodo,
  catalog: Map<string, TaskTag> = new Map(),
) {
  const deadline: TodoDeadline | null = todo.deadline;
  return {
    id: todo.id,
    revision: todo.revision,
    title: todo.title,
    notes: todo.notes,
    deadline: deadline
      ? {
          kind: deadline.kind,
          date: deadline.date,
          timeZone: deadline.timeZone,
          ...(deadline.at ? { at: deadline.at } : {}),
        }
      : null,
    status: todo.status,
    deferredUntil: todo.deferredUntil,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    completedAt: todo.completedAt ?? null,
    priority: todo.priority ?? 0,
    reminder: todo.reminder ?? 'default',
    tags: resolveTags(todo, catalog),
  };
}

/** Keeps every open item; completed ones fill the rest of the cap, newest first. */
function capItems(items: PersonalTodo[]): PersonalTodo[] {
  if (items.length <= MAX_ITEMS) return items;
  const open = items.filter((todo) => todo.status === 'open').slice(0, MAX_ITEMS);
  const done = items
    .filter((todo) => todo.status !== 'open')
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
    .slice(0, MAX_ITEMS - open.length);
  return [...open, ...done];
}

function resourceRevision(items: PersonalTodo[], catalog: Map<string, TaskTag>): string {
  const hash = createHash('sha256');
  // Resolved tag names and colors are part of the projection, so a catalog rename or delete is a new revision.
  for (const todo of items)
    hash.update(`${todo.id}:${todo.revision}:${JSON.stringify(resolveTags(todo, catalog))};`);
  return hash.digest('hex').slice(0, 16);
}

function mapError(error: unknown): never {
  if (error instanceof RemoteResourceRegistryError) throw error;
  if (error instanceof PersonalTodoOwnerChangedError) throw changedAccount();
  if (error instanceof TodoError) {
    if (error.code === 'CONFLICT') throw new RemoteResourceRegistryError('ALREADY_EXISTS', 'CONFLICT');
    if (error.code === 'NOT_FOUND') throw new RemoteResourceRegistryError('NOT_FOUND', 'NOT_FOUND');
    throw new RemoteResourceRegistryError('INVALID_PARAMS', error.code);
  }
  throw new RemoteResourceRegistryError('INTERNAL', 'Personal todo storage unavailable');
}

const invalid = (reason: string) => new RemoteResourceRegistryError('INVALID_PARAMS', reason);

/** Shape check only; the store validates content (lengths, dates, operations) again. */
function parseUpdate(input: Record<string, unknown> | undefined): PersonalTodoUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('input');
  if (Object.keys(input).some((key) => !(UPDATE_KEYS as readonly string[]).includes(key)))
    throw invalid('unknown field');
  const out: PersonalTodoUpdate = {};
  for (const key of ['id', 'creationRequestId', 'title', 'notes', 'until'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') throw invalid(key);
    out[key] = input[key] as string;
  }
  if (input.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(input.expectedRevision)) throw invalid('expectedRevision');
    out.expectedRevision = input.expectedRevision as number;
  }
  if (input.operation !== undefined) {
    if (typeof input.operation !== 'string' || !OPERATIONS.includes(input.operation))
      throw invalid('operation');
    out.operation = input.operation as PersonalTodoUpdate['operation'];
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || (input.priority as number) < 0 || (input.priority as number) > 3)
      throw invalid('priority');
    out.priority = input.priority as TodoPriority;
  }
  if (input.reminder !== undefined) {
    if (!(TODO_REMINDERS as readonly unknown[]).includes(input.reminder)) throw invalid('reminder');
    out.reminder = input.reminder as TodoReminder;
  }
  if (input.tagIds !== undefined) {
    if (!Array.isArray(input.tagIds) || input.tagIds.some((id) => typeof id !== 'string'))
      throw invalid('tagIds');
    out.tagIds = input.tagIds as string[];
  }
  if (input.deadline !== undefined) {
    const value = input.deadline as Record<string, unknown> | null;
    if (value === null) out.deadline = null;
    else if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.date !== 'string' ||
      typeof value.timeZone !== 'string' ||
      (value.kind !== 'date' && value.kind !== 'instant') ||
      (value.at !== undefined && typeof value.at !== 'string')
    )
      throw invalid('deadline');
    else
      out.deadline = {
        kind: value.kind,
        date: value.date,
        timeZone: value.timeZone,
        ...(value.at ? { at: value.at as string } : {}),
      };
  }
  return out;
}

export function createPersonalTodoRemoteProvider(): RemoteResourceProvider {
  return {
    collection: {
      id: PERSONAL_TODOS_COLLECTION,
      resourceKind: KIND,
      title,
      // Reached from the computer's page, never listed on the phone home.
      placement: 'hidden',
      icon: { name: 'check-square', fallbackText: '✓' },
    },
    async list() {
      return {
        collectionId: PERSONAL_TODOS_COLLECTION,
        revision: '1',
        items: [{ ref: resourceRef, display: { title }, links: [], revision: '1' }],
      };
    },
    async get(_context, request) {
      if (!request.client.primitives.includes(PERSONAL_TODOS_PRIMITIVE))
        throw new RemoteResourceRegistryError(
          'UNSUPPORTED_CAPABILITY',
          'client does not render personal todos',
        );
      if (request.ref.id !== RESOURCE_ID)
        throw new RemoteResourceRegistryError('NOT_FOUND', 'unknown personal todo resource');
      const scope = captureDataOwnerBroadcastScope();
      try {
        const { store, assertCurrent } = openPersonalTodoStore();
        const all = await store.list();
        assertCurrent();
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw changedAccount();
        const items = capItems(all);
        const catalog = await readTagCatalog();
        // The catalog read yields to the event loop: re-check the account before returning anything.
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw changedAccount();
        return {
          ref: resourceRef,
          revision: resourceRevision(items, catalog),
          display: { title },
          links: [],
          blocks: [
            {
              id: 'todos',
              primitive: PERSONAL_TODOS_PRIMITIVE,
              fallbackMarkdown: items
                .filter((todo) => todo.status === 'open')
                .map((todo) => `- ${todo.title}`)
                .join('\n')
                .slice(0, MAX_FALLBACK_CHARS),
              data: {
                items: items.map((todo) => personalTodoRemoteProjection(todo, catalog)),
                total: all.length,
                capabilities: PERSONAL_TODO_REMOTE_CAPABILITIES,
              },
            },
          ],
        };
      } catch (error) {
        return mapError(error);
      }
    },
    async invoke(_context, request) {
      if (request.actionId !== 'update')
        throw new RemoteResourceRegistryError('INVALID_PARAMS', 'unknown action');
      if (request.resourceRef && request.resourceRef.id !== RESOURCE_ID)
        throw new RemoteResourceRegistryError('NOT_FOUND', 'unknown personal todo resource');
      const update = parseUpdate(request.input);
      const scope = captureDataOwnerBroadcastScope();
      try {
        const { store, assertCurrent } = openPersonalTodoStore();
        const todo = await store.update(update);
        assertCurrent();
        // The write is durable; the changed push must not report a different account's write.
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw changedAccount();
        notifyPersonalTodosChanged(scope);
        return {
          result: { todo: personalTodoRemoteProjection(todo, await readTagCatalog()) },
          effects: [],
        };
      } catch (error) {
        return mapError(error);
      }
    },
  };
}

/** Invalidate, never duplicate, the host-owned list on every controller after any write path. */
export function broadcastPersonalTodosRemoteChanged(scope: DataOwnerBroadcastScope): void {
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  try {
    tapWindowBroadcast(
      REMOTE_RESOURCE_CHANGED_CHANNEL,
      { collectionId: PERSONAL_TODOS_COLLECTION, resourceRefs: [resourceRef] },
      scope.ownerStamp,
    );
  } catch {
    // A disconnected controller must not fail a persisted local write.
  }
}

let registered = false;

export function registerPersonalTodoRemoteResource(): void {
  if (registered) return;
  remoteResourceRegistry.register(createPersonalTodoRemoteProvider());
  onPersonalTodosChanged(broadcastPersonalTodosRemoteChanged);
  // Rows carry resolved tag names: a catalog change invalidates them on every controller.
  onTaskTagCatalogChanged(broadcastPersonalTodosRemoteChanged);
  registered = true;
}
