import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Calendar, Check, Plus, Tag, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TASK_TAG_COLORS, taskTagErrorKey, type TaskTag, type TaskTagColor } from '@cindy/maker-shared';
import type { TodoPriority } from '@cindy/maker-shared/teammate-todo';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerIdCurrent,
} from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
import { parseTodoWhen } from './parseTodoWhen';
import { personalDueText, PERSONAL_PRIORITIES } from './personalTodoModel';
import {
  PRIORITY_KEY,
  PriorityFlag,
  PriorityRing,
  TagDot,
  chipClass,
  tagDisplayName,
} from './personalTodoVisuals';
import { buildDeadline, quickDate, type QuickDate } from './todoDates';

const NO_TAG = '__none';
const QUICK_DATES: readonly QuickDate[] = ['today', 'tomorrow', 'nextMonday'];

function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function tagCreateError(cause: unknown, t: (key: string) => string): string {
  const detail = cause as { code?: unknown; message?: unknown } | null;
  if (detail?.code === 'LIMIT_EXCEEDED' || /\[LIMIT_EXCEEDED\]/.test(String(detail?.message)))
    return t('personalTodos.tagLimit');
  const key = taskTagErrorKey(cause, 'create');
  return t(`taskTags.${key === 'alreadyExists' ? key : 'failed'}`);
}

/** Enter and Esc for the composer's single-line fields; Enter is ignored while an IME composes. */
function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * Inline composer at the top of 我的待办 / 未完成. Collapsed it is one row; expanded it takes a
 * title, a note, a deadline, a priority and a tag. A date phrase in the title ("明天下午3点") is
 * recognised locally and can be dismissed. Adding keeps the composer open for the next item.
 */
export function PersonalTodoComposer({
  update,
  tags,
  supportedColors,
  createTag,
  activeTagId,
  onCreated,
}: {
  update: (input: PersonalTodoUpdate) => Promise<PersonalTodo>;
  tags: readonly TaskTag[];
  supportedColors: readonly TaskTagColor[];
  createTag: (name: string, color: TaskTagColor) => Promise<TaskTag>;
  /** The tag the list is filtered to; a new draft starts with it. */
  activeTagId: string | null;
  onCreated: (todo: PersonalTodo) => void;
}) {
  const { t, i18n } = useTranslation();
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [owner] = useState(getDataOwnerGeneration);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState<TodoPriority>(0);
  /** A date chosen by hand; an empty date is the explicit "no date". It overrides recognition. */
  const [manual, setManual] = useState<{ date: string; time: string } | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [tagId, setTagId] = useState<string | null>(null);
  const [newTag, setNewTag] = useState<{
    name: string;
    color: TaskTagColor;
    busy: boolean;
    error: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  /** After a lost reply the committed item is loaded here and the next add overwrites it. */
  const [target, setTarget] = useState<PersonalTodo | null>(null);
  const pending = useRef(false);
  /** A menu choice that reveals an inline field takes focus there instead of back on the chip. */
  const focusAfterClose = useRef<(() => void) | null>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const tagNameInput = useRef<HTMLInputElement>(null);
  const keepFocus = (event: Event) => {
    if (!focusAfterClose.current) return;
    event.preventDefault();
    focusAfterClose.current();
    focusAfterClose.current = null;
  };
  /** One id per creation: a failed add keeps it, so a retry cannot create a second item. */
  const requestId = useRef(newRequestId());

  const recognized = useMemo(
    () => parseTodoWhen(title, new Date(), zone, i18n.language),
    [title, zone, i18n.language],
  );
  const applied = manual || dismissed ? null : recognized;
  const deadline = manual
    ? manual.date
      ? buildDeadline(manual.date, manual.time || null, zone)
      : null
    : (applied?.deadline ?? null);
  const finalTitle = applied?.rest ? applied.rest : title.trim();
  const selectedTag = tags.find((tag) => tag.id === tagId) ?? null;
  const dateLabel = deadline
    ? personalDueText(deadline, {
        now: new Date(),
        locale: i18n.language,
        overdueLabel: () =>
          new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
            new Date(`${deadline.date}T12:00:00Z`),
          ),
      }).text
    : t('personalTodos.due.label');

  const expand = () => {
    setOpen(true);
    if (!tagId && activeTagId) setTagId(activeTagId);
  };
  const reset = () => {
    setTitle('');
    setNotes('');
    setPriority(0);
    setManual(null);
    setPickOpen(false);
    setDismissed(false);
    setError('');
    setConflict(false);
    setTarget(null);
    requestId.current = newRequestId();
  };

  const add = async () => {
    if (pending.current || !finalTitle || !isDataOwnerIdCurrent(owner)) return;
    pending.current = true;
    const attemptOwner = getDataOwnerGeneration();
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const saved = await update({
        ...(target
          ? { id: target.id, expectedRevision: target.revision }
          : { creationRequestId: requestId.current }),
        title: finalTitle,
        notes,
        deadline,
        priority,
        tagIds: selectedTag ? [selectedTag.id] : [],
      });
      if (!isDataOwnerGenerationCurrent(attemptOwner)) return;
      reset();
      onCreated(saved);
    } catch (cause) {
      const isConflict = extractIpcError(cause)?.code === 'ALREADY_EXISTS';
      setConflict(isConflict);
      setError(t(isConflict ? 'personalTodos.conflict' : 'personalTodos.saveFailed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const reload = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const items = await window.electronAPI.localDb.personalTodos.list();
      if (!isDataOwnerIdCurrent(owner)) return;
      const latest = items.find((item) => item.creationRequestId === requestId.current);
      if (latest) {
        setTarget(latest);
        setConflict(false);
        setError(t('personalTodos.conflict'));
      } else setError(t('personalTodos.loadFailed'));
    } catch {
      setError(t('personalTodos.loadFailed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const createNewTag = async () => {
    if (!newTag || newTag.busy || !newTag.name.trim()) return;
    setNewTag({ ...newTag, busy: true, error: '' });
    try {
      const created = await createTag(newTag.name.trim(), newTag.color);
      setTagId(created.id);
      setNewTag(null);
    } catch (cause) {
      setNewTag((current) => (current ? { ...current, busy: false, error: tagCreateError(cause, t) } : current));
    }
  };

  const fieldKey = (event: KeyboardEvent) => {
    if (composing(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void add();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  if (!open)
    return (
      <button
        type="button"
        onClick={expand}
        className="mb-1 flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-13 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        <span aria-hidden className="-mx-0.5 inline-flex size-6 shrink-0 items-center justify-center">
          <Plus size={16} />
        </span>
        {t('personalTodos.add')}
      </button>
    );

  const inputClass =
    'h-auto min-w-0 flex-1 border-transparent bg-transparent px-0 focus:border-transparent focus:ring-0';
  return (
    <div className="mb-3 flex flex-col gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] py-3 pl-3 pr-3 focus-within:border-[var(--text-tertiary-stone)]">
      <div className="flex items-center gap-3">
        <span className="-mx-0.5 inline-flex size-6 shrink-0 items-center justify-center">
          <PriorityRing priority={priority} />
        </span>
        <Input
          autoFocus
          size="md"
          value={title}
          onChange={(value) => {
            setTitle(value);
            if (!value) setDismissed(false);
          }}
          onKeyDown={fieldKey}
          maxLength={300}
          ariaLabel={t('personalTodos.title')}
          placeholder={t('personalTodos.title')}
          className="flex-1"
          inputClassName={`${inputClass} text-14`}
        />
      </div>
      <Input
        size="sm"
        value={notes}
        onChange={setNotes}
        onKeyDown={fieldKey}
        maxLength={4000}
        ariaLabel={t('personalTodos.notes')}
        placeholder={t('personalTodos.notes')}
        className="ml-8"
        inputClassName={`${inputClass} text-12 text-[var(--text-secondary)]`}
      />
      <div className="flex flex-wrap items-center gap-1.5 pl-8 pt-1.5">
        <span className="inline-flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={chipClass(Boolean(deadline))}>
                <Calendar size={13} aria-hidden />
                {dateLabel}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48" onCloseAutoFocus={keepFocus}>
              {QUICK_DATES.map((choice) => {
                const date = quickDate(choice, new Date(), zone);
                return (
                  <DropdownMenuItem
                    key={choice}
                    onSelect={() => {
                      setManual({ date, time: '' });
                      setPickOpen(false);
                    }}
                  >
                    {t(`personalTodos.due.${choice}`)}
                    <DropdownMenuShortcut>
                      {new Intl.DateTimeFormat(i18n.language, {
                        timeZone: 'UTC',
                        month: 'short',
                        day: 'numeric',
                      }).format(new Date(`${date}T12:00:00Z`))}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuItem
                onSelect={() => {
                  setManual({ date: '', time: '' });
                  setPickOpen(false);
                }}
              >
                {t('personalTodos.due.none')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setManual((current) => current ?? { date: '', time: '' });
                  setPickOpen(true);
                  focusAfterClose.current = () => dateInput.current?.focus();
                }}
              >
                {t('personalTodos.due.pick')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {applied ? (
            <Tip text={t('personalTodos.composer.dismissRecognition', { phrase: applied.phrase })}>
              <button
                type="button"
                aria-label={t('personalTodos.composer.dismissRecognition', { phrase: applied.phrase })}
                onClick={() => setDismissed(true)}
                className="inline-flex size-6 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <X size={12} aria-hidden />
              </button>
            </Tip>
          ) : null}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={chipClass(priority > 0)}>
              <PriorityFlag priority={priority} size={13} />
              {priority
                ? t(`personalTodos.priority.short.${PRIORITY_KEY[priority]}`)
                : t('personalTodos.priority.label')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuRadioGroup
              value={String(priority)}
              onValueChange={(value) => setPriority(Number(value) as TodoPriority)}
            >
              {PERSONAL_PRIORITIES.map((value) => (
                <DropdownMenuRadioItem key={value} value={String(value)}>
                  <PriorityFlag priority={value} />
                  <span className="ml-2">{t(`personalTodos.priority.${PRIORITY_KEY[value]}`)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={chipClass(Boolean(selectedTag))}>
              {selectedTag ? <TagDot color={selectedTag.color} /> : <Tag size={13} aria-hidden />}
              <span className="max-w-32 truncate">
                {selectedTag ? tagDisplayName(selectedTag, t) : t('taskTags.title')}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48" onCloseAutoFocus={keepFocus}>
            <DropdownMenuRadioGroup
              value={selectedTag?.id ?? NO_TAG}
              onValueChange={(value) => setTagId(value === NO_TAG ? null : value)}
            >
              {tags.map((tag) => (
                <DropdownMenuRadioItem key={tag.id} value={tag.id}>
                  <TagDot color={tag.color} />
                  <span className="ml-2 truncate">{tagDisplayName(tag, t)}</span>
                </DropdownMenuRadioItem>
              ))}
              <DropdownMenuRadioItem value={NO_TAG}>{t('personalTodos.untagged')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setNewTag((current) => current ?? { name: '', color: 'blue', busy: false, error: '' });
                focusAfterClose.current = () => tagNameInput.current?.focus();
              }}
            >
              {t('personalTodos.newTag')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <Button
          type="button"
          variant="secondary"
          tone="quiet"
          size="sm"
          disabled={busy}
          onClick={() => {
            reset();
            setNewTag(null);
            setOpen(false);
          }}
        >
          {t('personalTodos.composer.cancel')}
        </Button>
        <Button type="button" size="sm" disabled={busy || !finalTitle} onClick={() => void add()}>
          {t(target ? 'personalTodos.overwrite' : 'personalTodos.composer.add')}
        </Button>
      </div>
      {pickOpen && manual ? (
        <div className="flex items-center gap-2 pl-8 pt-1">
          <Input
            type="date"
            size="sm"
            inputRef={dateInput}
            ariaLabel={t('personalTodos.deadline')}
            value={manual.date}
            onChange={(date) => setManual({ date, time: date ? manual.time : '' })}
            className="w-40"
          />
          <Input
            type="time"
            size="sm"
            ariaLabel={t('personalTodos.deadlineTime')}
            value={manual.time}
            disabled={!manual.date}
            onChange={(time) => setManual({ ...manual, time })}
            className="w-32"
          />
        </div>
      ) : null}
      {newTag ? (
        <div className="ml-8 mt-1 flex flex-col gap-2 rounded-lg border border-[var(--border-default)] p-2">
          <Input
            inputRef={tagNameInput}
            size="sm"
            value={newTag.name}
            maxLength={80}
            disabled={newTag.busy}
            ariaLabel={t('taskTags.name')}
            placeholder={t('taskTags.name')}
            onChange={(name) => setNewTag({ ...newTag, name })}
            onKeyDown={(event) => {
              if (composing(event)) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                void createNewTag();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setNewTag(null);
              }
            }}
          />
          <div role="radiogroup" aria-label={t('taskTags.color')} className="flex flex-wrap gap-1">
            {TASK_TAG_COLORS.map((color) => (
              <Tip key={color} text={t(`taskTags.${color}`)}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={newTag.color === color}
                  aria-label={t(`taskTags.${color}`)}
                  disabled={newTag.busy || !supportedColors.includes(color)}
                  onClick={() => setNewTag({ ...newTag, color })}
                  className="inline-flex size-6 items-center justify-center rounded-full outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40"
                >
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full border-[0.5px] border-[var(--border-default)] ${color === 'white' ? 'text-[var(--task-tag-white-check)]' : 'text-[var(--text-primary-on-dark)]'}`}
                    style={{ backgroundColor: `var(--task-tag-${color})` }}
                  >
                    {newTag.color === color ? <Check size={11} strokeWidth={2.5} aria-hidden /> : null}
                  </span>
                </button>
              </Tip>
            ))}
          </div>
          {newTag.error ? (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {newTag.error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="xs"
              disabled={newTag.busy}
              onClick={() => setNewTag(null)}
            >
              {t('taskTags.cancel')}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={newTag.busy || !newTag.name.trim()}
              onClick={() => void createNewTag()}
            >
              {t('taskTags.create')}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 pl-8 text-12 text-[var(--error-fg)]">
          {error}
          {conflict ? (
            <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => void reload()}>
              {t('personalTodos.reloadVersion')}
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
