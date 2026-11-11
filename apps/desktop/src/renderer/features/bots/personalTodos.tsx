import {
  subscribePersonalTodos,
  getPersonalTodoSnapshot,
  ensurePersonalTodos,
  refreshPersonalTodos,
  updatePersonalTodo,
} from './personalTodoCache';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { TaskTag } from '@cindy/maker-shared';
import type { TodoPriority, TodoReminder } from '@cindy/maker-shared/teammate-todo';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
import {
  DEFAULT_PERSONAL_GROUPING,
  DEFAULT_PERSONAL_ORDER,
  PERSONAL_GROUPINGS,
  PERSONAL_ORDERS,
  PERSONAL_PRIORITIES,
  resolvePersonalTag,
  type PersonalGrouping,
  type PersonalOrder,
} from './personalTodoModel';
import {
  PRIORITY_KEY,
  PriorityFlag,
  TagDot,
  chipClass,
  tagDisplayName,
} from './personalTodoVisuals';
import { quickDate } from './todoDates';

export type TodoOwnershipView = 'mine' | 'teammates';
const SCOPES: readonly TodoOwnershipView[] = ['mine', 'teammates'];

/** A per-account preference kept in localStorage; storage that cannot be read or written only costs the memory. */
function useStoredChoice<T extends string>(
  name: string,
  dataOwnerId: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
) {
  const key = `${name}:${dataOwnerId ?? 'local'}`;
  const load = (): T => {
    try {
      const saved = localStorage.getItem(key);
      return allowed.find((value) => value === saved) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState<T>(load);
  useEffect(() => setValue(load()), [key]);
  const select = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Viewing still works without preference storage. */
    }
  };
  return [value, select] as const;
}

export function usePersonalTodos() {
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const { dataOwnerId } = getDataOwnerGeneration();
  const snapshot = useSyncExternalStore(
    subscribePersonalTodos,
    getPersonalTodoSnapshot,
    getPersonalTodoSnapshot,
  );
  useEffect(ensurePersonalTodos, [dataOwnerId, ownerGeneration]);
  // A stored 'all' (the retired mixed list) or anything unknown falls back to 我的待办.
  const [scope, selectScope] = useStoredChoice('personal-todo-view', dataOwnerId, SCOPES, 'mine');
  const [grouping, selectGrouping] = useStoredChoice<PersonalGrouping>(
    'personal-todo-grouping',
    dataOwnerId,
    PERSONAL_GROUPINGS,
    DEFAULT_PERSONAL_GROUPING,
  );
  const [order, selectOrder] = useStoredChoice<PersonalOrder>(
    'personal-todo-order',
    dataOwnerId,
    PERSONAL_ORDERS,
    DEFAULT_PERSONAL_ORDER,
  );
  return {
    ...snapshot,
    refresh: refreshPersonalTodos,
    update: updatePersonalTodo,
    scope,
    selectScope,
    grouping,
    selectGrouping,
    order,
    selectOrder,
    dataOwnerId,
  };
}

/** Wall-clock HH:mm of an instant in the zone the deadline was written in. */
function instantTime(deadline: PersonalTodo['deadline']): string {
  if (deadline?.kind !== 'instant' || !deadline.at) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: deadline.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(deadline.at));
  } catch {
    return '';
  }
}

const TIME_REMINDERS: readonly TodoReminder[] = ['default', 'before-15m', 'before-1h', 'off'];
const DATE_REMINDERS: readonly TodoReminder[] = ['default', 'before-1d', 'off'];
const REMINDER_KEY: Record<TodoReminder, string> = {
  default: 'onTime',
  'before-15m': 'before15m',
  'before-1h': 'before1h',
  'before-1d': 'dayBefore',
  off: 'off',
};

/** A label above a control, in the same voice as FormField for rows that are not one input. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-13 font-medium text-[var(--settings-section-title)]">{label}</span>
      {children}
    </div>
  );
}

export function PersonalTodoEditor({
  initial,
  tags,
  update,
  onClose,
  onSaved,
}: {
  initial: PersonalTodo;
  /** This device's task-tag catalog; ids missing from it read as untagged. */
  tags: readonly TaskTag[];
  update: (input: PersonalTodoUpdate) => Promise<PersonalTodo>;
  onClose: () => void;
  onSaved: (todo: PersonalTodo, operation?: PersonalTodoUpdate['operation']) => void;
}) {
  const { t } = useTranslation();
  const [owner] = useState(getDataOwnerGeneration);
  const [title, setTitle] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  const [deadline, setDeadline] = useState(initial.deadline?.date ?? '');
  const [time, setTime] = useState(() => instantTime(initial.deadline));
  const [until, setUntil] = useState('');
  const [current, setCurrent] = useState(initial);
  const [priority, setPriority] = useState<TodoPriority>(initial.priority ?? 0);
  const [tagId, setTagId] = useState<string | null>(
    () => resolvePersonalTag(initial, tags)?.id ?? null,
  );
  const [reminder, setReminder] = useState<TodoReminder>(initial.reminder ?? 'default');
  // Only what the owner changed is sent, so an untouched save never rewrites a priority, a tag
  // set by an Agent or a reminder the editor could not display.
  const touched = useRef({ priority: false, tag: false, reminder: false });
  const initialHasTime = useRef(instantTime(initial.deadline) !== '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const untilMs = Date.parse(until);
  const untilValid = Number.isFinite(untilMs);
  const hasTime = Boolean(deadline && time);
  const offered = hasTime ? TIME_REMINDERS : DATE_REMINDERS;
  // A stored value this kind of deadline does not offer reads as the default until changed.
  const shownReminder = offered.includes(reminder) ? reminder : 'default';

  const buildDeadline = (): PersonalTodoUpdate['deadline'] => {
    if (!deadline) return null;
    const saved = current.deadline;
    // Untouched deadlines keep their original zone and metadata.
    if (saved && saved.date === deadline && instantTime(saved) === time) return saved;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (time) {
      const at = new Date(`${deadline}T${time}`);
      if (!Number.isNaN(at.getTime()))
        return { kind: 'instant', date: deadline, at: at.toISOString(), timeZone: zone };
    }
    return {
      kind: 'date',
      date: deadline,
      timeZone: saved?.kind === 'date' ? saved.timeZone : zone,
    };
  };

  const act = async (operation?: PersonalTodoUpdate['operation'], deferTo?: string) => {
    if (busy || !isDataOwnerIdCurrent(owner)) return;
    const resume = deferTo ?? until;
    const resumeMs = Date.parse(resume);
    if (operation === 'later' && (!Number.isFinite(resumeMs) || resumeMs <= Date.now())) {
      setError(t('personalTodos.deferInPast'));
      return;
    }
    const attemptOwner = getDataOwnerGeneration();
    const sendReminder =
      Boolean(deadline) &&
      (touched.current.reminder || (!offered.includes(reminder) && hasTime !== initialHasTime.current));
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const saved = await update({
        id: current.id,
        expectedRevision: current.revision,
        title: title.trim(),
        notes,
        deadline: buildDeadline(),
        ...(touched.current.priority ? { priority } : {}),
        ...(touched.current.tag ? { tagIds: tagId ? [tagId] : [] } : {}),
        ...(sendReminder ? { reminder: shownReminder } : {}),
        operation,
        ...(operation === 'later' ? { until: new Date(resume).toISOString() } : {}),
      });
      if (!isDataOwnerGenerationCurrent(attemptOwner)) return;
      setCurrent(saved);
      onSaved(saved, operation);
    } catch (cause) {
      const conflicted = extractIpcError(cause)?.code === 'ALREADY_EXISTS';
      setConflict(conflicted);
      setError(t(conflicted ? 'personalTodos.conflict' : 'personalTodos.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const reloadLatest = async () => {
    setBusy(true);
    try {
      const items = await window.electronAPI.localDb.personalTodos.list();
      const latest = items.find((item) => item.id === current.id);
      if (!isDataOwnerIdCurrent(owner)) return;
      if (latest) {
        setCurrent(latest);
        // Fields the owner did not touch follow the latest version; touched ones stay as typed.
        if (!touched.current.priority) setPriority(latest.priority ?? 0);
        if (!touched.current.tag) setTagId(resolvePersonalTag(latest, tags)?.id ?? null);
        if (!touched.current.reminder) setReminder(latest.reminder ?? 'default');
        setConflict(false);
        setOverwrite(true);
        setError(t('personalTodos.conflict'));
      } else setError(t('personalTodos.loadFailed'));
    } catch {
      setError(t('personalTodos.loadFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Quick defer targets in the computer's own time zone.
  const clock = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const deferChips: Array<{ key: string; label: string; at: string }> = [
    ...(clock.getHours() < 20
      ? [
          {
            key: 'tonight',
            label: t('personalTodos.deferTonight'),
            at: `${quickDate('today', clock, zone)}T20:00`,
          },
        ]
      : []),
    { key: 'tomorrow', label: t('personalTodos.due.tomorrow'), at: `${quickDate('tomorrow', clock, zone)}T09:00` },
    { key: 'nextMonday', label: t('personalTodos.due.nextMonday'), at: `${quickDate('nextMonday', clock, zone)}T09:00` },
  ];

  return (
    <aside
      aria-label={t('personalTodos.details')}
      className="min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-13 text-[var(--text-primary)]"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void act();
        }}
      >
        <h2 className="font-medium">{t('personalTodos.details')}</h2>
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
        <Row label={t('personalTodos.priority.label')}>
          <div role="radiogroup" aria-label={t('personalTodos.priority.label')} className="flex gap-1">
            {PERSONAL_PRIORITIES.map((value) => {
              const name = t(`personalTodos.priority.${PRIORITY_KEY[value]}`);
              return (
                <Tip key={value} text={name}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={priority === value}
                    aria-label={name}
                    disabled={busy}
                    onClick={() => {
                      touched.current.priority = true;
                      setPriority(value);
                    }}
                    className={cn(
                      'inline-flex size-8 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60',
                      priority === value ? 'bg-[var(--surface-chip)]' : 'hover:bg-[var(--surface-hover)]',
                    )}
                  >
                    <PriorityFlag priority={value} size={15} />
                  </button>
                </Tip>
              );
            })}
          </div>
        </Row>
        {tags.length > 0 ? (
          <Row label={t('taskTags.title')}>
            <div role="group" aria-label={t('taskTags.title')} className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={tagId === tag.id}
                  disabled={busy}
                  onClick={() => {
                    touched.current.tag = true;
                    setTagId(tag.id);
                  }}
                  className={chipClass(tagId === tag.id)}
                >
                  <TagDot color={tag.color} />
                  <span className="max-w-40 truncate">{tagDisplayName(tag, t)}</span>
                </button>
              ))}
              <button
                type="button"
                aria-pressed={tagId === null}
                disabled={busy}
                onClick={() => {
                  touched.current.tag = true;
                  setTagId(null);
                }}
                className={chipClass(tagId === null)}
              >
                {t('personalTodos.noTag')}
              </button>
            </div>
          </Row>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <FormField label={t('personalTodos.deadline')}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={deadline}
                onChange={(value) => {
                  setDeadline(value);
                  if (!value) setTime('');
                }}
                disabled={busy}
              />
            )}
          </FormField>
          <FormField label={t('personalTodos.deadlineTime')}>
            {(props) => (
              <Input
                {...props}
                type="time"
                value={time}
                onChange={setTime}
                disabled={busy || !deadline}
              />
            )}
          </FormField>
        </div>
        {deadline ? (
          <Row label={t('personalTodos.reminder.label')}>
            <SegmentedControl<TodoReminder>
              aria-label={t('personalTodos.reminder.label')}
              value={shownReminder}
              disabled={busy}
              height={32}
              optionHeight={28}
              optionClassName="px-2"
              onValueChange={(value) => {
                touched.current.reminder = true;
                setReminder(value);
              }}
              options={offered.map((value) => ({
                value,
                label:
                  value === 'default'
                    ? t(hasTime ? 'personalTodos.reminder.onTime' : 'personalTodos.reminder.dayOf')
                    : t(`personalTodos.reminder.${REMINDER_KEY[value]}`),
              }))}
            />
          </Row>
        ) : null}
        {current.status === 'open' ? (
          <>
            <Row label={t('personalTodos.defer')}>
              <div className="flex flex-wrap gap-1.5">
                {deferChips.map((chip) => (
                  <Button
                    key={chip.key}
                    type="button"
                    variant="secondary"
                    size="sm"
                    compact
                    disabled={busy}
                    onClick={() => void act('later', chip.at)}
                  >
                    {chip.label}
                  </Button>
                ))}
              </div>
            </Row>
            <FormField label={t('personalTodos.deferUntil')}>
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
          </>
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
            onClick={() => void reloadLatest()}
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void act(current.status === 'done' ? 'reopen' : 'complete')}
          >
            {t(current.status === 'done' ? 'personalTodos.reopen' : 'personalTodos.complete')}
          </Button>
          {current.status === 'open' ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !untilValid}
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
