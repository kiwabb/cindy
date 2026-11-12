import { useState } from 'react';
import { Check, ChevronRight, ListChecks, Plus, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskTag } from '@cindy/maker-shared';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
import { TODO_MAX_SUBTASKS } from '@cindy/maker-shared/teammate-todo';
import { StepAdder, StepList } from './PersonalTodoSteps';
import {
  appendedSteps,
  personalDueText,
  removedSteps,
  stepsProgress,
  toggledSteps,
  type PersonalStepsInput,
} from './personalTodoModel';
import { CONFLICT_DRAFT_PREFIX } from './usePersonalTodoSync';
import { PRIORITY_KEY, PriorityRing, TagDot, tagDisplayName } from './personalTodoVisuals';
import type { TodoBoardBucket, TodoBoardView } from './teammateTodoBoard';

function shortDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
}

/**
 * One personal todo. The checkbox and the body are sibling buttons (no nested interactive
 * controls); the tag and the due text inside the body are plain text.
 */
export function PersonalTodoRow({
  todo,
  view,
  tag,
  groupBucket,
  selected,
  now,
  onOpen,
  onUpdate,
  onSteps,
  conflict,
}: {
  todo: PersonalTodo;
  view: TodoBoardView;
  /** The tag to show on the right, or null when the row shows none. */
  tag: TaskTag | null;
  /** Set when the list is grouped by deadline, so the due text skips what the heading says. */
  groupBucket?: TodoBoardBucket;
  selected: boolean;
  now: Date;
  onOpen: (todo: PersonalTodo) => void;
  onUpdate: (input: PersonalTodoUpdate) => Promise<void>;
  /** Saves a checklist edit without closing the details panel or announcing a save. */
  onSteps: (input: PersonalTodoUpdate) => Promise<void>;
  /** Multi-computer sync: an edit made here that the main computer refused, with the owner's choices. */
  conflict?: { busy: boolean; onResolve: (choice: 'mine' | 'theirs') => void };
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [stepBusy, setStepBusy] = useState(false);
  const done = todo.status === 'done';
  const priority = todo.priority ?? 0;
  const label =
    `${t(done ? 'personalTodos.reopen' : 'personalTodos.complete')}: ${todo.title}` +
    (priority && !done ? ` · ${t(`personalTodos.priority.${PRIORITY_KEY[priority]}`)}` : '');
  const steps = todo.subtasks;
  const progress = stepsProgress(steps);
  // A sync conflict draft has no todo on the main computer to edit; its steps are only shown.
  const readOnly = todo.id.startsWith(CONFLICT_DRAFT_PREFIX);
  const saveSteps = async (subtasks: PersonalStepsInput | null): Promise<boolean> => {
    if (!subtasks || stepBusy || readOnly) return false;
    setStepBusy(true);
    setFailed(false);
    try {
      await onSteps({ id: todo.id, expectedRevision: todo.revision, subtasks });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setStepBusy(false);
    }
  };
  const stepsLabel = t(expanded ? 'personalTodos.steps.collapse' : 'personalTodos.steps.expand', {
    title: todo.title,
  });
  const addLabel = t('personalTodos.steps.addTo', { title: todo.title });
  const due =
    view === 'later'
      ? {
          text: todo.deferredUntil
            ? t('bots.todoBoard.laterUntil', { date: shortDate(todo.deferredUntil, i18n.language) })
            : '',
          overdue: false,
        }
      : view === 'done'
        ? {
            text: todo.completedAt
              ? t('bots.todoBoard.completedOn', {
                  date: shortDate(todo.completedAt, i18n.language),
                })
              : '',
            overdue: false,
          }
        : personalDueText(todo.deadline, {
            groupBucket,
            now,
            locale: i18n.language,
            overdueLabel: (days) =>
              days === 0
                ? t('personalTodos.due.overdueToday')
                : t('personalTodos.due.overdue', { count: days }),
          });
  return (
    <div data-testid="todo-board-row">
      <div
        className={cn(
          'group/row flex min-h-10 w-full items-center gap-3 rounded-lg px-2 py-1.5 focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--focus-ring)]',
          selected ? 'bg-[var(--surface-chip)]' : 'hover:bg-[var(--surface-hover)]',
        )}
      >
        {progress ? (
          <Tip text={stepsLabel}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={stepsLabel}
              onClick={() => {
                setExpanded((open) => !open);
                setAdding(false);
              }}
              className="-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <ChevronRight
                size={12}
                strokeWidth={2.2}
                aria-hidden
                className={cn('transition-transform', expanded && 'rotate-90')}
              />
            </button>
          </Tip>
        ) : readOnly ? (
          <span aria-hidden className="-mr-1 size-5 shrink-0" />
        ) : (
          <Tip text={addLabel}>
            <button
              type="button"
              aria-label={addLabel}
              onClick={() => {
                setExpanded(true);
                setAdding(true);
              }}
              className="-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] opacity-0 outline-none transition-opacity hover:bg-[var(--surface-hover)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] group-hover/row:opacity-100"
            >
              <Plus size={12} strokeWidth={2.2} aria-hidden />
            </button>
          </Tip>
        )}
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={label}
          aria-busy={busy}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailed(false);
            try {
              await onUpdate({
                id: todo.id,
                expectedRevision: todo.revision,
                operation: done ? 'reopen' : 'complete',
              });
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
            }
          }}
          className="-mx-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {done ? (
            <span
              aria-hidden
              className={cn(
                'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)]',
                busy && 'opacity-50',
              )}
            >
              <Check size={12} />
            </span>
          ) : (
            <PriorityRing priority={priority} className={busy ? 'opacity-50' : undefined} />
          )}
        </button>
        <button
          type="button"
          aria-label={todo.title}
          onClick={() => onOpen(todo)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        >
          <span className="min-w-0 flex-1">
            <span
              title={todo.title}
              className={cn(
                'block truncate text-13 leading-5',
                done
                  ? 'text-[var(--text-secondary)] line-through decoration-[var(--text-tertiary)]'
                  : 'text-[var(--text-primary)]',
              )}
            >
              {todo.title}
            </span>
            {progress || todo.notes ? (
              <span className="flex min-w-0 items-center gap-2 text-12 leading-4 text-[var(--text-secondary)]">
                {progress ? (
                  <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                    <ListChecks size={12} aria-hidden />
                    {progress.text}
                  </span>
                ) : null}
                {todo.notes ? (
                  <span title={todo.notes} className="min-w-0 truncate">
                    {todo.notes}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
          {tag ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <TagDot color={tag.color} />
              {tagDisplayName(tag, t)}
            </span>
          ) : null}
          {due.text ? (
            <span
              className={cn(
                'shrink-0 whitespace-nowrap text-right text-12',
                due.overdue
                  ? 'font-medium text-[var(--error-fg)]'
                  : view === 'done'
                    ? 'text-[var(--text-tertiary)]'
                    : 'text-[var(--text-secondary)]',
              )}
            >
              {due.text}
            </span>
          ) : null}
        </button>
      </div>
      {expanded ? (
        <div className="flex flex-col pb-2 pl-16 pr-2.5">
          <StepList
            steps={steps}
            now={now}
            disabled={stepBusy}
            readOnly={readOnly}
            onToggle={(id) => void saveSteps(toggledSteps(steps, id))}
            onRemove={(id) => void saveSteps(removedSteps(steps, id))}
          />
          {readOnly ? null : (
            <StepAdder
              adding={adding}
              full={steps.length >= TODO_MAX_SUBTASKS}
              cancellable
              onStart={() => setAdding(true)}
              onAdd={(title) => saveSteps(appendedSteps(steps, title))}
              onClose={(added) => {
                setAdding(false);
                // Nothing was added to a row that had no steps: fold it back.
                if (!added && !steps.length) setExpanded(false);
              }}
            />
          )}
        </div>
      ) : null}
      {conflict ? (
        <div
          data-testid="todo-sync-conflict"
          className="flex flex-wrap items-center gap-2 pb-1.5 pl-10 pr-2 text-12 text-[var(--text-primary)]"
        >
          <span className="inline-flex items-center gap-1">
            <TriangleAlert size={12} className="text-[var(--warning-fg)]" aria-hidden />
            {t('personalTodos.conflict')}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={conflict.busy}
            onClick={() => conflict.onResolve('mine')}
          >
            {t('personalTodos.sync.useMine')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={conflict.busy}
            onClick={() => conflict.onResolve('theirs')}
          >
            {t('personalTodos.sync.keepTheirs')}
          </Button>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="px-2 text-12 text-[var(--error-fg)]">
          {t('personalTodos.rowFailed')}
        </p>
      ) : null}
    </div>
  );
}
