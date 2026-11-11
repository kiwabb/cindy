import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type {
  PersonalTodo,
  PersonalTodoSyncChoice,
  PersonalTodoSyncConflict,
  PersonalTodoSyncStatus,
} from '../../../shared/personalTodo';

/** Rows of a refused creation carry this prefix: they exist only here, never on the main computer. */
export const CONFLICT_DRAFT_PREFIX = 'conflict:';

/** The refused creation as a list row, so the owner can see what is waiting for a choice. */
export function conflictDraftTodo(conflict: PersonalTodoSyncConflict): PersonalTodo | null {
  const draft = conflict.draft;
  if (!draft || typeof draft.title !== 'string') return null;
  const at = new Date().toISOString();
  return {
    id: `${CONFLICT_DRAFT_PREFIX}${conflict.id}`,
    revision: 0,
    title: draft.title,
    notes: draft.notes ?? '',
    deadline: draft.deadline ?? null,
    status: 'open',
    deferredUntil: null,
    createdAt: at,
    updatedAt: at,
    priority: draft.priority ?? 0,
    tagIds: draft.tagIds ?? [],
    reminder: draft.reminder ?? 'default',
    subtasks: (draft.subtasks ?? []).map((step, index) => ({ id: step.id ?? `draft-${index}`, title: step.title, done: step.done ?? false })),
    ownership: 'self',
    source: 'manual',
  };
}

/** Fallback only: peer presence and every sync outcome already push a status change. Local IPC, no server request. */
const STATUS_REFRESH_MS = 120_000;

/**
 * Multi-computer sync of personal todos: the status of this computer's role, the edits the main
 * computer refused (by todo id) and the actions on them. Absent on a build without the bridge.
 */
export function usePersonalTodoSync(onResolved: () => void) {
  const [status, setStatus] = useState<PersonalTodoSyncStatus | null>(null);
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, string[]>>(new Map());
  const [drafts, setDrafts] = useState<PersonalTodo[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const resolved = useRef(onResolved);
  resolved.current = onResolved;

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.localDb?.personalTodos?.sync;
    if (!api) return;
    const owner = getDataOwnerGeneration();
    const read = ++sequence.current;
    try {
      const next = await api.status();
      const refused = next.conflicts > 0 ? await api.conflicts() : [];
      if (read !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setStatus(next);
      const rows: Array<{ id: string; conflictId: string; draft?: PersonalTodo }> = refused.flatMap((entry) => {
        const draft = conflictDraftTodo(entry);
        if (draft) return [{ id: draft.id, conflictId: entry.id, draft }];
        return entry.todoId ? [{ id: entry.todoId, conflictId: entry.id }] : [];
      });
      // One todo can have several refused edits (later ones queued behind the first): one choice covers them in order.
      const byTodo = new Map<string, string[]>();
      for (const row of rows) byTodo.set(row.id, [...(byTodo.get(row.id) ?? []), row.conflictId]);
      setConflicts(byTodo);
      setDrafts(rows.flatMap((row) => (row.draft ? [row.draft] : [])));
    } catch {
      // The page keeps its last status; a failed read must not hide the todos.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const api = window.electronAPI?.localDb?.personalTodos?.sync;
    const off = api?.onChanged(() => void refresh());
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_MS);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      off?.();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      sequence.current++;
    };
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<PersonalTodoSyncStatus>) => {
      if (busy) return;
      const owner = getDataOwnerGeneration();
      setBusy(true);
      setFailed(false);
      try {
        const next = await action();
        if (!isDataOwnerGenerationCurrent(owner)) return;
        setStatus(next);
        await refresh();
        resolved.current();
      } catch {
        if (isDataOwnerGenerationCurrent(owner)) {
          setFailed(true);
          await refresh();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  return {
    status,
    conflicts,
    drafts,
    busy,
    failed,
    toggle: (on: boolean) =>
      run(() =>
        on
          ? window.electronAPI.localDb.personalTodos.sync.enable()
          : window.electronAPI.localDb.personalTodos.sync.disable(),
      ),
    setAsHome: () => run(() => window.electronAPI.localDb.personalTodos.sync.setAsHome()),
    resolve: (todoId: string, choice: PersonalTodoSyncChoice) => {
      const edits = conflicts.get(todoId);
      return edits === undefined
        ? Promise.resolve()
        : run(async () => {
            const sync = window.electronAPI.localDb.personalTodos.sync;
            let next = await sync.status();
            for (const conflictId of edits) next = await sync.resolve(conflictId, choice);
            return next;
          });
    },
  };
}
