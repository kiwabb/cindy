/**
 * 个人待办（电脑上的 `personal-todos` 远程资源）：读、改、新建、删除，并在宿主推送变更时重读。
 *
 * - `available`：null 尚未确认；false = 这台电脑不提供（旧版桌面或集合不存在），入口隐藏；
 * - 读失败（电脑离线、断线）保留上一次成功的数据，只标 `failed`；
 * - 写入带 expectedRevision；冲突（ALREADY_EXISTS）或已不存在（NOT_FOUND）时重读最新并把错误上抛，由页面显示短提示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TaskTag, TaskTagColor } from '@cindy/maker-shared';
import { TODO_REMINDERS, todoLocalDate, type TodoPriority, type TodoReminder } from '@cindy/maker-shared/teammate-todo';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  getRemoteResource,
  invokeRemoteResourceAction,
  loadRemoteResourceManifest,
} from '@/device-link/remoteResources';

export const PERSONAL_TODOS_COLLECTION = 'personal-todos';
const PRIMITIVE = 'personal-todos';
const REF = { collectionId: PERSONAL_TODOS_COLLECTION, kind: 'personal-todos', id: 'todos:me' } as const;

/** Host-resolved tag; `nameCustomized` is only present when true so preset names localize on the phone. */
export type PersonalTodoTag = Pick<TaskTag, 'id' | 'name' | 'nameCustomized'> & { color: TaskTagColor };

/** Mirrors the host projection (desktop `personalTodoRemoteProjection`). */
export interface PersonalTodoItem {
  id: string;
  revision: number;
  title: string;
  notes: string;
  deadline: { kind: 'date' | 'instant'; date: string; timeZone: string; at?: string } | null;
  status: 'open' | 'done';
  deferredUntil: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** 0 none, 1 low, 2 medium, 3 high. Absent on an older host. */
  priority: TodoPriority;
  reminder: TodoReminder;
  /** Resolved against the host's tag catalog; unknown ids are already dropped. Empty on an older host. */
  tags: PersonalTodoTag[];
}

export interface PersonalTodoUpdateInput {
  id?: string;
  creationRequestId?: string;
  expectedRevision?: number;
  title?: string;
  notes?: string;
  deadline?: PersonalTodoItem['deadline'];
  priority?: TodoPriority;
  tagIds?: string[];
  reminder?: TodoReminder;
  operation?: 'complete' | 'reopen' | 'delete' | 'later' | 'restore';
  until?: string;
}

/** Fields only a host advertising `capabilities.organize` accepts (the released desktop rejects unknown fields). */
const ORGANIZE_KEYS = ['priority', 'tagIds', 'reminder'] as const;

interface Snapshot {
  available: boolean | null;
  /** The host advertised `capabilities.organize`: it accepts priority / tagIds / reminder updates. */
  organize: boolean;
  items: PersonalTodoItem[];
  loaded: boolean;
  failed: boolean;
}

const INITIAL: Snapshot = { available: null, organize: false, items: [], loaded: false, failed: false };
/** Last good projection per account and computer, so an offline computer keeps its list and entry. */
const lastGood = new Map<string, Snapshot>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function parseTags(value: unknown): PersonalTodoTag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(tag => {
    if (!isRecord(tag) || typeof tag.id !== 'string' || typeof tag.name !== 'string') return [];
    // An unknown color from a newer host is kept as text; the screen falls back to the neutral dot.
    const color = (typeof tag.color === 'string' ? tag.color : 'none') as TaskTagColor;
    return [{ id: tag.id, name: tag.name, color, ...(tag.nameCustomized === true ? { nameCustomized: true as const } : {}) }];
  });
}

function parseItem(value: unknown): PersonalTodoItem | null {
  if (!isRecord(value)) return null;
  const { id, revision, title, notes, status } = value;
  if (typeof id !== 'string' || !Number.isSafeInteger(revision) || typeof title !== 'string') return null;
  if (typeof notes !== 'string' || (status !== 'open' && status !== 'done')) return null;
  const deadline = isRecord(value.deadline)
    && typeof value.deadline.date === 'string'
    && typeof value.deadline.timeZone === 'string'
    ? {
        kind: value.deadline.kind === 'instant' ? ('instant' as const) : ('date' as const),
        date: value.deadline.date,
        timeZone: value.deadline.timeZone,
        ...(typeof value.deadline.at === 'string' ? { at: value.deadline.at } : {}),
      }
    : null;
  return {
    id, revision: revision as number, title, notes, status, deadline,
    deferredUntil: typeof value.deferredUntil === 'string' ? value.deferredUntil : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    priority: value.priority === 1 || value.priority === 2 || value.priority === 3 ? value.priority : 0,
    reminder: (TODO_REMINDERS as readonly unknown[]).includes(value.reminder) ? value.reminder as TodoReminder : 'default',
    tags: parseTags(value.tags),
  };
}

/** A host that does not advertise `organize` (older desktop) must never receive the new update fields. */
export function parsePersonalTodosOrganize(resource: { blocks?: Array<{ primitive: string; data?: unknown }> }): boolean {
  const data = resource.blocks?.find(block => block.primitive === PRIMITIVE)?.data;
  return isRecord(data) && isRecord(data.capabilities) && typeof data.capabilities.organize === 'number' && data.capabilities.organize >= 1;
}

/** Drops priority / tagIds / reminder when the host has not advertised support. */
export function personalTodoUpdateForHost(input: PersonalTodoUpdateInput, organize: boolean): PersonalTodoUpdateInput {
  if (organize) return input;
  const out = { ...input };
  for (const key of ORGANIZE_KEYS) delete out[key];
  return out;
}

export function parsePersonalTodos(resource: { blocks?: Array<{ primitive: string; data?: unknown }> }): PersonalTodoItem[] {
  const data = resource.blocks?.find(block => block.primitive === PRIMITIVE)?.data;
  if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('INVALID_RESPONSE');
  return data.items.flatMap(item => parseItem(item) ?? []);
}

export interface PersonalTodoGroups {
  open: PersonalTodoItem[];
  later: PersonalTodoItem[];
  done: PersonalTodoItem[];
}

const deadlineKey = (todo: PersonalTodoItem) => todo.deadline?.date ?? '9999-99-99';

/** Open items by due date; deferred ones wait in `later` until their time; done newest first. */
export function groupPersonalTodos(items: readonly PersonalTodoItem[], now = new Date()): PersonalTodoGroups {
  const deferred = (todo: PersonalTodoItem) => !!todo.deferredUntil && Date.parse(todo.deferredUntil) > now.getTime();
  const byDue = (a: PersonalTodoItem, b: PersonalTodoItem) =>
    deadlineKey(a).localeCompare(deadlineKey(b)) || a.createdAt.localeCompare(b.createdAt);
  return {
    open: items.filter(todo => todo.status === 'open' && !deferred(todo)).sort(byDue),
    later: items.filter(todo => todo.status === 'open' && deferred(todo)).sort(byDue),
    done: items.filter(todo => todo.status === 'done')
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)),
  };
}

/** Open, not deferred, with a deadline today or earlier. */
export function personalTodoDue(todo: PersonalTodoItem, now = new Date()): boolean {
  if (todo.status !== 'open' || !todo.deadline) return false;
  if (todo.deferredUntil && Date.parse(todo.deferredUntil) > now.getTime()) return false;
  return todo.deadline.date <= todoLocalDate(now, todo.deadline.timeZone);
}

export function newCreationRequestId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export type PersonalTodoErrorKind = 'conflict' | 'gone' | 'failed';

export function personalTodoErrorKind(error: unknown): PersonalTodoErrorKind {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code.toUpperCase() : '';
  if (code === 'ALREADY_EXISTS') return 'conflict';
  if (code === 'NOT_FOUND') return 'gone';
  return 'failed';
}

export function usePersonalTodos({ deviceId, deviceName, enabled }: { deviceId: string; deviceName: string; enabled: boolean }) {
  const { i18n } = useTranslation();
  const { user, accountGeneration } = useAuth();
  const { invoke, openLink, onRemoteResourceChanged } = useDeviceLink();
  const cacheKey = `${user?.id ?? ''}:${accountGeneration}:${deviceId}`;
  const [state, setState] = useState<Snapshot>(() => lastGood.get(cacheKey) ?? INITIAL);
  const epoch = useRef(0);

  const commit = useCallback((next: Snapshot) => {
    lastGood.set(cacheKey, next);
    setState(next);
  }, [cacheKey]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const mine = ++epoch.current;
    try {
      await openLink(deviceId);
      const target = { deviceId, deviceName };
      const manifest = await loadRemoteResourceManifest(invoke, target, i18n.language);
      if (mine !== epoch.current) return;
      if (!manifest?.collections.some(c => c.id === PERSONAL_TODOS_COLLECTION && c.resourceKind === REF.kind)) {
        commit({ available: false, organize: false, items: [], loaded: true, failed: false });
        return;
      }
      const resource = await getRemoteResource(invoke, target, REF, i18n.language, [PRIMITIVE]);
      if (mine !== epoch.current) return;
      commit({ available: true, organize: parsePersonalTodosOrganize(resource), items: parsePersonalTodos(resource), loaded: true, failed: false });
    } catch {
      if (mine === epoch.current) setState(previous => ({ ...previous, loaded: true, failed: true }));
    }
  }, [commit, deviceId, deviceName, enabled, i18n.language, invoke, openLink]);

  useEffect(() => {
    setState(lastGood.get(cacheKey) ?? INITIAL);
  }, [cacheKey]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const off = onRemoteResourceChanged((id, payload) => {
      if (id === deviceId && payload.collectionId === PERSONAL_TODOS_COLLECTION) void refresh();
    });
    const app = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    return () => { epoch.current++; off(); app.remove(); };
  }, [deviceId, enabled, onRemoteResourceChanged, refresh]);

  /** One write on the computer. A conflict or vanished item re-reads the latest before the error is thrown. */
  const update = useCallback(async (input: PersonalTodoUpdateInput): Promise<PersonalTodoItem | null> => {
    try {
      await openLink(deviceId);
      const response = await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
        collectionId: PERSONAL_TODOS_COLLECTION, resourceRef: REF, actionId: 'update',
        input: personalTodoUpdateForHost(input, state.organize) as unknown as Record<string, unknown>,
      }, i18n.language);
      void refresh();
      return isRecord(response.result) ? parseItem(response.result.todo) : null;
    } catch (error) {
      if (personalTodoErrorKind(error) !== 'failed') void refresh();
      throw error;
    }
  }, [deviceId, deviceName, i18n.language, invoke, openLink, refresh, state.organize]);

  return { ...state, refresh, update };
}
