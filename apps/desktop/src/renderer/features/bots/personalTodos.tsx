import {
  subscribePersonalTodos,
  getPersonalTodoSnapshot,
  ensurePersonalTodos,
  refreshPersonalTodos,
  updatePersonalTodo,
} from './personalTodoCache';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerIdCurrent,
} from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { extractIpcError } from '@/utils/ipcError';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
import type { TodoBoardItem, TodoBoardView } from './teammateTodoBoard';
import { emptyTodoState, applyTodoPatch } from '@cindy/maker-shared/teammate-todo';

export type TodoOwnershipView = 'mine' | 'assistant' | 'all';
export function usePersonalTodos() {
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const { dataOwnerId } = getDataOwnerGeneration();
  const snapshot = useSyncExternalStore(
    subscribePersonalTodos,
    getPersonalTodoSnapshot,
    getPersonalTodoSnapshot,
  );
  useEffect(ensurePersonalTodos, [dataOwnerId, ownerGeneration]);
  const [scope, setScope] = useState<TodoOwnershipView>('mine');
  const key = `personal-todo-view:${dataOwnerId ?? 'local'}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      setScope(saved === 'all' || saved === 'assistant' ? saved : 'mine');
    } catch {
      setScope('mine');
    }
  }, [key]);
  const selectScope = (value: TodoOwnershipView) => {
    setScope(value);
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Viewing still works without preference storage. */
    }
  };
  return {
    ...snapshot,
    refresh: refreshPersonalTodos,
    update: updatePersonalTodo,
    scope,
    selectScope,
    dataOwnerId,
  };
}

/** Adapt dates to the existing board grouping only; this is never a teammate record. */
export function personalBoardItems(
  items: PersonalTodo[],
  view: TodoBoardView,
  label: string,
): TodoBoardItem[] {
  return items
    .filter((t) => {
      const deferred =
        t.status === 'open' && !!t.deferredUntil && Date.parse(t.deferredUntil) > Date.now();
      return view === 'done'
        ? t.status === 'done'
        : view === 'later'
          ? deferred
          : t.status === 'open' && !deferred;
    })
    .map((personal) => {
      const todo = applyTodoPatch(
        emptyTodoState(),
        {
          key: personal.id,
          title: personal.title,
          outcome: personal.title,
          progress: personal.notes,
          deadlineOverride: { value: personal.deadline },
        },
        personal.id,
      );
      todo.revision = personal.revision;
      todo.status = personal.status;
      todo.createdAt = personal.createdAt;
      todo.updatedAt = personal.updatedAt;
      todo.history =
        personal.status === 'done'
          ? personal.completedAt
            ? [{ at: personal.completedAt, summary: '' }]
            : []
          : [];
      todo.decision = personal.deferredUntil
        ? { kind: 'later', until: personal.deferredUntil }
        : null;
      return {
        todo,
        personal,
        teammate: { key: 'personal', botId: '', name: label, offline: false, route: '' },
      };
    });
}

export function PersonalTodoEditor({
  initial,
  update,
  onClose,
  onSaved,
}: {
  initial: PersonalTodo | null;
  update: (input: PersonalTodoUpdate) => Promise<PersonalTodo>;
  onClose: () => void;
  onSaved: (
    todo: PersonalTodo,
    operation?: PersonalTodoUpdate['operation'],
    created?: boolean,
  ) => void;
}) {
  const { t } = useTranslation();
  const [creationRequestId] = useState(() =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
  );
  const [owner] = useState(getDataOwnerGeneration);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [deadline, setDeadline] = useState(initial?.deadline?.date ?? '');
  const [until, setUntil] = useState('');
  const [current, setCurrent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const act = async (operation?: PersonalTodoUpdate['operation']) => {
    if (busy || !isDataOwnerIdCurrent(owner)) return;
    const attemptOwner = getDataOwnerGeneration();
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const saved = await update({
        id: current?.id,
        ...(!current ? { creationRequestId } : {}),
        expectedRevision: current?.revision,
        title: title.trim(),
        notes,
        deadline: deadline
          ? {
              kind: 'date',
              date: deadline,
              timeZone:
                current?.deadline?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : null,
        operation,
        ...(operation === 'later' ? { until: new Date(until).toISOString() } : {}),
      });
      if (!isDataOwnerGenerationCurrent(attemptOwner)) return;
      setCurrent(saved);
      onSaved(saved, operation, initial === null);
    } catch (cause) {
      const conflict = extractIpcError(cause)?.code === 'ALREADY_EXISTS';
      setConflict(conflict);
      setError(t(conflict ? 'personalTodos.conflict' : 'personalTodos.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      aria-label={t('personalTodos.details')}
      className="min-w-0 rounded-xl border border-[var(--border-default)] p-4 text-13 text-[var(--text-primary)]"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void act();
        }}
      >
        <h2 className="font-medium">
          {t(current ? 'personalTodos.details' : 'personalTodos.add')}
        </h2>
        <p className="text-12 text-[var(--text-tertiary)]">{t('personalTodos.ownerSource')}</p>
        <FormField label={t('personalTodos.title')} required>
          {(props) => (
            <Input
              {...props}
              required
              maxLength={300}
              value={title}
              onChange={setTitle}
              disabled={busy}
              autoFocus
            />
          )}
        </FormField>
        <FormField label={t('personalTodos.notes')}>
          {(props) => (
            <Textarea
              {...props}
              maxLength={4000}
              value={notes}
              onChange={setNotes}
              disabled={busy}
            />
          )}
        </FormField>
        <FormField label={t('personalTodos.deadline')}>
          {(props) => (
            <Input {...props} type="date" value={deadline} onChange={setDeadline} disabled={busy} />
          )}
        </FormField>
        {current?.status === 'open' ? (
          <FormField label={t('personalTodos.deferUntil')} hint={t('personalTodos.deferHint')}>
            {(props) => (
              <Input
                {...props}
                type="datetime-local"
                value={until}
                onChange={setUntil}
                disabled={busy}
              />
            )}
          </FormField>
        ) : null}
        {error ? (
          <p role="alert" className="text-12 text-[var(--error-fg)]">
            {error}
          </p>
        ) : null}
        {conflict ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const items = await window.electronAPI.localDb.personalTodos.list();
                const latest = items.find((item) =>
                  current ? item.id === current.id : item.creationRequestId === creationRequestId,
                );
                if (!isDataOwnerIdCurrent(owner)) return;
                if (latest) {
                  setCurrent(latest);
                  setConflict(false);
                  setOverwrite(true);
                  setError(t('personalTodos.conflict'));
                } else setError(t('personalTodos.loadFailed'));
              } catch {
                setError(t('personalTodos.loadFailed'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('personalTodos.reloadVersion')}
          </Button>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy || !title.trim()}>
            {t(
              busy
                ? 'personalTodos.saving'
                : overwrite
                  ? 'personalTodos.overwrite'
                  : 'personalTodos.save',
            )}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t('personalTodos.close')}
          </Button>
          {current ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void act(current.status === 'done' ? 'reopen' : 'complete')}
              >
                {t(current.status === 'done' ? 'personalTodos.reopen' : 'personalTodos.complete')}
              </Button>
              {current.status === 'open' && until ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act('later')}
                >
                  {t('personalTodos.defer')}
                </Button>
              ) : null}
              {current.deferredUntil ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act('restore')}
                >
                  {t('personalTodos.restore')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                {t('personalTodos.delete')}
              </Button>
            </>
          ) : null}
        </div>
        {deleting ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('personalTodos.deleteConfirm')}</span>
            <Button type="button" size="sm" disabled={busy} onClick={() => void act('delete')}>
              {t('personalTodos.delete')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              {t('personalTodos.close')}
            </Button>
          </div>
        ) : null}
      </form>
    </aside>
  );
}
