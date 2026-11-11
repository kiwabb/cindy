import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { personalBoardItems, PersonalTodoEditor, usePersonalTodos } from './personalTodos';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
/**
 * 内置待办页：个人事项直接管理，按截止分组，分进行中、稍后再说、已完成三档。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  createTodoDueComparator,
  effectiveTodoDeadline,
  todoDateLabel,
  todoDue,
  todoOverdue,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SETTINGS_SECTION_TITLE_CLASS } from '@/components/ui/settings-rows';
import { cn } from '@/lib/utils';
import { groupTodoBoardItems, type TodoBoardItem, type TodoBoardView } from './teammateTodoBoard';

function shortDate(value: string, locale: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00Z') : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

/** 期限前的到期红点。 */
function TodoDueDot() {
  return (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--error-fg)]" />
  );
}

function Deadline({ todo, view }: { todo: TeammateTodo; view: TodoBoardView }) {
  const { t, i18n } = useTranslation();
  const deadline = effectiveTodoDeadline(todo);
  const date = todoDateLabel(todo, i18n.language);
  const label = date && !deadline ? t('bots.todoBoard.suggested', { date }) : date;
  const overdue = todoOverdue(todo);
  // 「稍后再说」里的事项还没回到列表，红点只给进行中的。
  const due = view === 'open' && todoDue(todo);
  const until =
    view === 'later' && todo.decision?.until
      ? t('bots.todoBoard.laterUntil', { date: shortDate(todo.decision.until, i18n.language) })
      : '';
  if (!label && !until) return null;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-2 text-12',
        !deadline
          ? 'text-[var(--text-tertiary)]'
          : overdue
            ? 'font-medium text-[var(--error-fg)]'
            : due
              ? 'font-medium text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)]',
      )}
    >
      {due ? <TodoDueDot /> : null}
      {label ? <span>{label}</span> : null}
      {label && until ? <span className="font-normal text-[var(--text-tertiary)]">·</span> : null}
      {until ? <span className="font-normal text-[var(--text-tertiary)]">{until}</span> : null}
    </span>
  );
}

function TodoRow({
  item,
  view,
  onOpen,
  onUpdate,
}: {
  item: TodoBoardItem;
  view: TodoBoardView;
  onOpen: (item: TodoBoardItem) => void;
  onUpdate: (input: PersonalTodoUpdate) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const todo = item.personal;
  const done = todo.status === 'done';
  const label = `${t(done ? 'personalTodos.reopen' : 'personalTodos.complete')}: ${todo.title}`;
  return (
    <div data-testid="todo-board-row">
      <div className="flex min-h-8 w-full items-center gap-3 rounded-lg px-2 py-1 hover:bg-[var(--surface-hover)] focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--focus-ring)]">
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
                'inline-flex size-5 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)]',
                busy && 'opacity-50',
              )}
            >
              <Check size={12} />
            </span>
          ) : (
            <Circle
              size={20}
              aria-hidden
              className={cn('text-[var(--text-tertiary)]', busy && 'opacity-50')}
            />
          )}
        </button>
        <button
          type="button"
          aria-label={todo.title}
          onClick={() => onOpen(item)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        >
          <span className="min-w-0 flex-1">
            <span
              title={todo.title}
              className={cn(
                'block truncate text-13 leading-5',
                done ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
              )}
            >
              {todo.title}
            </span>
            {todo.completedAt ? (
              <span className="block truncate text-12 leading-4 text-[var(--text-tertiary)]">
                {t('bots.todoBoard.completedOn', {
                  date: shortDate(todo.completedAt, i18n.language),
                })}
              </span>
            ) : null}
          </span>
          {view !== 'done' ? <Deadline todo={item.todo} view={view} /> : null}
        </button>
      </div>
      {failed ? (
        <p role="alert" className="px-2 text-12 text-[var(--error-fg)]">
          {t('personalTodos.rowFailed')}
        </p>
      ) : null}
    </div>
  );
}

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="px-2 py-1.5 [&+&]:border-t [&+&]:border-[var(--border-default)]">
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <h3 className="text-12 font-normal text-[var(--text-tertiary)]">{label}</h3>
        <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{count}</span>
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

export function TeammateTodosView() {
  useOptionalDataOwnerGeneration();
  const { dataOwnerId } = getDataOwnerGeneration();
  return <TodoBoard key={dataOwnerId ?? 'local'} />;
}

function completionTime(item: TodoBoardItem): number {
  return Date.parse(item.personal.completedAt ?? item.personal.createdAt) || 0;
}

function TodoBoard() {
  const { t } = useTranslation();
  const personal = usePersonalTodos();
  const [editor, setEditor] = useState<PersonalTodo | null | undefined>(undefined);
  useEffect(() => setEditor(undefined), [personal.dataOwnerId]);
  const [view, setView] = useState<TodoBoardView>('open');
  const [doneOpen, setDoneOpen] = useState(false);
  const [notice, setNotice] = useState<{
    title: string;
    target: TodoBoardView;
    operation?: string;
  } | null>(null);
  const saved = (
    todo: PersonalTodo,
    operation?: PersonalTodoUpdate['operation'],
    created = false,
  ) => {
    const target =
      todo.status === 'done'
        ? 'done'
        : todo.deferredUntil && Date.parse(todo.deferredUntil) > Date.now()
          ? 'later'
          : 'open';
    setEditor(undefined);
    setNotice({ title: todo.title, target, operation });
    if (created || operation === 'reopen' || operation === 'restore') {
      setView(created ? target : 'open');
    }
  };
  const updateRow = async (input: PersonalTodoUpdate) =>
    saved(await personal.update(input), input.operation);

  const items = useMemo(
    () =>
      personalBoardItems(personal.items, view).sort((a, b) =>
        view === 'done'
          ? completionTime(b) - completionTime(a)
          : createTodoDueComparator()(a.todo, b.todo),
      ),
    [view, personal.items],
  );
  const done = useMemo(
    () =>
      view === 'open'
        ? personalBoardItems(personal.items, 'done').sort(
            (a, b) => completionTime(b) - completionTime(a),
          )
        : [],
    [view, personal.items],
  );
  const groups = useMemo(() => (view === 'done' ? [] : groupTodoBoardItems(items)), [items, view]);
  const loading = personal.loading;
  const open = (item: TodoBoardItem) => setEditor(item.personal);

  const empty = (text: string) => (
    <div
      className="flex flex-col items-center gap-1.5 pb-10 pt-14 text-center"
      data-testid="todo-board-empty"
    >
      <span className="text-13 text-[var(--text-secondary)]">{text}</span>
    </div>
  );

  let list: ReactNode;
  if (view === 'done') {
    list = items.length ? (
      <Section label={t('bots.todoBoard.view.done')} count={items.length}>
        {items.map((item) => (
          <TodoRow
            key={item.personal.id}
            item={item}
            view="done"
            onOpen={open}
            onUpdate={updateRow}
          />
        ))}
      </Section>
    ) : loading ? null : (
      empty(t('bots.todoBoard.empty.done'))
    );
  } else {
    list = groups.length
      ? groups.map((group) => (
          <Section
            key={group.bucket}
            label={t(`bots.todoBoard.bucket.${group.bucket}`)}
            count={group.items.length}
          >
            {group.items.map((item) => (
              <TodoRow
                key={item.personal.id}
                item={item}
                view={view}
                onOpen={open}
                onUpdate={updateRow}
              />
            ))}
          </Section>
        ))
      : loading
        ? null
        : empty(t('personalTodos.empty'));
  }

  return (
    <main
      className="h-full overflow-y-auto pl-4 pr-6 [scrollbar-gutter:stable]"
      data-testid="todo-board"
    >
      <div className="mx-auto w-full max-w-[920px] px-1 pb-32 pt-6">
        <div className="flex flex-wrap items-center justify-end gap-3 px-2">
          <h1 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'min-w-0 flex-[1_1_12rem]')}>
            {t('bots.todoBoard.title')}
          </h1>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <SegmentedControl<TodoBoardView>
              aria-label={t('bots.todoBoard.view.label')}
              value={view}
              onValueChange={setView}
              options={(['open', 'later', 'done'] as const).map((value) => ({
                value,
                label: t(`bots.todoBoard.view.${value}`),
              }))}
            />
          </div>
        </div>
        {notice ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 px-4 pt-3 text-12 text-[var(--text-secondary)]"
          >
            <span>
              {t(
                notice.operation === 'delete'
                  ? 'personalTodos.deletedNotice'
                  : 'personalTodos.savedNotice',
                { title: notice.title },
              )}
            </span>
            {notice.operation !== 'delete' ? (
              <Button variant="secondary" size="sm" onClick={() => setView(notice.target)}>
                {t(`bots.todoBoard.view.${notice.target}`)}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3 px-2 py-4">
          <Button size="sm" onClick={() => setEditor(null)}>
            {t('personalTodos.add')}
          </Button>
        </div>
        {personal.failed ? (
          <p role="alert" className="px-4 text-12 text-[var(--error-fg)]">
            {t('personalTodos.loadFailed')}{' '}
            <Button variant="secondary" size="sm" onClick={() => void personal.refresh()}>
              {t('commonUi.retry')}
            </Button>
          </p>
        ) : null}
        <div
          className={cn(
            'mt-4 grid min-w-0 gap-4',
            editor !== undefined && 'min-[1100px]:grid-cols-[minmax(0,1fr)_320px]',
          )}
        >
          {editor !== undefined ? (
            <div className="min-w-0 min-[1100px]:col-start-2 min-[1100px]:row-start-1">
              <PersonalTodoEditor
                key={`${personal.dataOwnerId}:${editor?.id ?? 'new'}`}
                initial={editor}
                update={personal.update}
                onClose={() => setEditor(undefined)}
                onSaved={saved}
              />
            </div>
          ) : null}
          <div className="min-w-0 min-[1100px]:col-start-1 min-[1100px]:row-start-1">
            {personal.failed && !personal.items.length ? null : list}
            {view === 'open' && done.length > 0 ? (
              <div className="mt-1.5 border-t border-[var(--border-default)] px-2 py-1.5">
                <button
                  type="button"
                  aria-expanded={doneOpen}
                  onClick={() => setDoneOpen((value) => !value)}
                  className="flex min-h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-12 text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                >
                  <span>{t('bots.glance.doneCount', { count: done.length })}</span>
                  <ChevronDown
                    size={12}
                    className={cn(
                      'shrink-0 transition-transform duration-150',
                      doneOpen && 'rotate-180',
                    )}
                  />
                </button>
                {doneOpen ? (
                  <div className="flex flex-col">
                    {done.map((item) => (
                      <TodoRow
                        key={item.personal.id}
                        item={item}
                        view="done"
                        onOpen={open}
                        onUpdate={updateRow}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
