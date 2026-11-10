import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';

let owner = getDataOwnerGeneration();
let state = { items: [] as PersonalTodo[], loading: true, failed: false };
let pending = false;
let hasSnapshot = false;
let staleRead = false;
const duringRead = new Map<string, { item: PersonalTodo; deleted: boolean }>();
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
function current() {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  sequence++;
  pending = false;
  hasSnapshot = false;
  duringRead.clear();
  clearTimeout(timer);
  state = { items: [], loading: true, failed: false };
}
export function personalTodoIsOpen(item: PersonalTodo, now = Date.now()) {
  return item.status === 'open' && !(item.deferredUntil && Date.parse(item.deferredUntil) > now);
}
function schedule() {
  clearTimeout(timer);
  if (!listeners.size) return;
  const next = Math.min(
    ...state.items
      .map((item) => Date.parse(item.deferredUntil ?? ''))
      .filter((at) => at > Date.now()),
  );
  if (Number.isFinite(next))
    timer = setTimeout(
      () => {
        current();
        state = { ...state, items: [...state.items] };
        emit();
        schedule();
      },
      Math.min(next - Date.now() + 1, 2147483647),
    );
}
export function getPersonalTodoSnapshot() {
  current();
  return state;
}
export async function refreshPersonalTodos() {
  current();
  if (pending) return;
  pending = true;
  const capturedOwner = owner,
    read = ++sequence;
  try {
    const items = await window.electronAPI.localDb.personalTodos.list();
    if (isDataOwnerGenerationCurrent(capturedOwner) && read === sequence) {
      const merged = new Map(items.map((item) => [item.id, item]));
      for (const [id, change] of duringRead) {
        if ((merged.get(id)?.revision ?? -1) > change.item.revision) continue;
        if (change.deleted) merged.delete(id);
        else merged.set(id, change.item);
      }
      hasSnapshot = true;
      state = { items: [...merged.values()], loading: false, failed: false };
    }
  } catch {
    if (isDataOwnerGenerationCurrent(capturedOwner) && read === sequence)
      state = { ...state, loading: false, failed: true };
  } finally {
    if (read === sequence) {
      pending = false;
      duringRead.clear();
      emit();
      schedule();
      if (staleRead) {
        staleRead = false;
        void refreshPersonalTodos();
      }
    }
  }
}
export function ensurePersonalTodos() {
  current();
  if (state.loading && !pending) void refreshPersonalTodos();
  schedule();
}
function changedElsewhere() {
  current();
  if (pending) staleRead = true; // the read in flight may predate this write
  else void refreshPersonalTodos();
}
const focus = () => void refreshPersonalTodos();
let unsubscribeChanged: (() => void) | undefined;
export function subscribePersonalTodos(listener: () => void) {
  current();
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('focus', focus);
    // Writes from any surface (Agent tools, phone) land here; stamps of another owner are ignored.
    unsubscribeChanged = window.electronAPI?.localDb?.personalTodos?.onChanged?.((stamp) => {
      if (isDataOwnerPushCurrent(stamp)) changedElsewhere();
    });
  }
  schedule();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener('focus', focus);
      unsubscribeChanged?.();
      unsubscribeChanged = undefined;
      clearTimeout(timer);
    }
  };
}
export async function updatePersonalTodo(input: PersonalTodoUpdate) {
  current();
  const capturedOwner = owner;
  let saved: PersonalTodo;
  try {
    saved = await window.electronAPI.localDb.personalTodos.update(input);
  } catch (error) {
    if (isDataOwnerGenerationCurrent(capturedOwner) && state.loading) void refreshPersonalTodos();
    throw error;
  }
  current();
  if (!isDataOwnerGenerationCurrent(capturedOwner)) throw new Error('OWNER_CHANGED');
  if (pending) duringRead.set(saved.id, { item: saved, deleted: input.operation === 'delete' });
  state = {
    items:
      input.operation === 'delete'
        ? state.items.filter((t) => t.id !== saved.id)
        : [saved, ...state.items.filter((t) => t.id !== saved.id)],
    loading: !hasSnapshot,
    failed: false,
  };
  emit();
  schedule();
  // A write never turns an incomplete first snapshot into an authoritative list.
  if (!hasSnapshot && !pending) void refreshPersonalTodos();
  return saved;
}
export const personalTodoCacheTesting = {
  reset() {
    clearTimeout(timer);
    sequence++;
    pending = false;
    hasSnapshot = false;
    staleRead = false;
    duringRead.clear();
    owner = getDataOwnerGeneration();
    state = { items: [], loading: true, failed: false };
  },
};
