import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { PersonalTodoComposer } from './PersonalTodoComposer';
import { PersonalTodoRow } from './PersonalTodoRow';
import { PersonalGroupingMenu, PersonalTagChips } from './PersonalTodoToolbar';
import {
  ALL_TAGS,
  effectiveTagFilter,
  matchesTagFilter,
  personalCounts,
  personalSections,
  personalTagChips,
  resolvePersonalTag,
  type PersonalSection,
  type PersonalTagFilter,
} from './personalTodoModel';
import { PRIORITY_KEY, chipClass, tagDisplayName } from './personalTodoVisuals';
import { PersonalTodoEditor, usePersonalTodos, type TodoOwnershipView } from './personalTodos';
import { usePersonalTaskTags } from './usePersonalTaskTags';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
/**
 * 内置待办页：「我的待办」直接管理（行内新增、分组、标签筛选、详情面板），「伙伴待办」沿用只读清单
 * 并打开对应伙伴。两者各有各的清单，不混排；个人归属不由伙伴 origin 字段推断。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronRight, CircleDot, ListFilter } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  effectiveTodoDeadline,
  todoDateLabel,
  todoDue,
  todoOverdue,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { SETTINGS_SECTION_TITLE_CLASS } from '@/components/settings/settingsRowClasses';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { TodoDueDot } from './BotGlancePopover';
import {
  groupTodoBoardItems,
  refreshTodoBoardEntry,
  todoBoardItems,
  type TodoBoardFilter,
  type TodoBoardItem,
  type TodoBoardOrigin,
  type TodoBoardTeammate,
  type TodoBoardView,
} from './teammateTodoBoard';
import {
  TodoBoardSources,
  useTodoBoardEntries,
  useTodoBoardTeammates,
} from './useTeammateTodoBoard';

type Translate = (key: string, options?: Record<string, unknown>) => string;

function shortDate(value: string, locale: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00Z') : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

/** 与近况同一套来源文案；来源名已含标签时不重复。 */
function sourceText(todo: TeammateTodo, t: Translate): string {
  const source = todo.sources[0];
  if (!source || source.kind === 'conversation') return t('bots.glance.source.conversation');
  const kind = t(`bots.glance.source.${source.kind}`);
  const label = source.label?.trim();
  return label && !kind.toLowerCase().includes(label.toLowerCase()) ? `${kind} · ${label}` : kind;
}

function teammateText(teammate: TodoBoardTeammate, t: Translate): string {
  return [
    teammate.name,
    teammate.deviceName,
    teammate.deviceName && teammate.offline ? t('bots.glance.offline') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function metaText(item: TodoBoardItem, t: Translate): string {
  const source = sourceText(item.todo, t);
  // 伙伴发现的标出来；交办的来源不是对话时补一句「你交代的」，免得看成伙伴自己找的。
  const origin =
    item.todo.origin === 'discovered'
      ? t('bots.todoBoard.discovered')
      : source === t('bots.glance.source.conversation')
        ? null
        : t('bots.glance.source.conversation');
  return [teammateText(item.teammate, t), origin, source].filter(Boolean).join(' · ');
}

/** 悬停一行：来源全文、下一步说明、截止的来历。 */
function tipText(todo: TeammateTodo, t: Translate, locale: string): ReactNode {
  const lines: Array<[string, string]> = [];
  const source = todo.sources[0];
  lines.push([
    t('bots.todoBoard.tip.source'),
    source && source.kind !== 'conversation'
      ? [t(`bots.glance.source.${source.kind}`), source.label?.trim()].filter(Boolean).join(' · ')
      : t('bots.glance.source.conversation'),
  ]);
  if (todo.next) {
    const instruction = todo.next.instruction.trim() || todo.next.label;
    lines.push([
      t('bots.todoBoard.tip.next'),
      `${t(`bots.todoBoard.nextKind.${todo.next.kind}`)} · ${instruction}`,
    ]);
  }
  const deadline = effectiveTodoDeadline(todo);
  const label = todoDateLabel(todo, locale);
  if (deadline && todo.deadlineOverride && todo.sourceDeadline) {
    lines.push([
      t('bots.todoBoard.tip.deadline'),
      t('bots.todoBoard.tip.overridden', {
        date: label,
        source: shortDate(todo.sourceDeadline.date, locale),
      }),
    ]);
  } else if (deadline?.quote) {
    lines.push([
      t('bots.todoBoard.tip.deadline'),
      t('bots.todoBoard.tip.quote', { date: label, quote: deadline.quote }),
    ]);
  } else if (!deadline && todo.deadlineCandidate) {
    lines.push([
      t('bots.todoBoard.tip.suggested'),
      `${shortDate(todo.deadlineCandidate.value.date, locale)} · ${todo.deadlineCandidate.reason}`,
    ]);
  } else if (!deadline && todo.suggestedDate) {
    lines.push([t('bots.todoBoard.tip.suggested'), shortDate(todo.suggestedDate, locale)]);
  }
  if (todo.status === 'open' && todo.decision?.kind === 'later' && todo.decision.until) {
    lines.push([
      t('bots.todoBoard.tip.later'),
      t('bots.todoBoard.laterUntil', { date: shortDate(todo.decision.until, locale) }),
    ]);
  }
  const completion = todo.history[todo.history.length - 1];
  if (todo.status === 'done' && completion)
    lines.push([t('bots.todoBoard.tip.done'), completion.summary]);
  return (
    <span className="block max-w-[420px] whitespace-pre-line [overflow-wrap:anywhere]">
      {lines.map(([key, value]) => (
        <span key={key} className="block">
          <span className="text-[var(--text-tertiary)]">{key}</span>
          {'  '}
          {value}
        </span>
      ))}
    </span>
  );
}

function Next({ todo, offline }: { todo: TeammateTodo; offline: boolean }) {
  if (!todo.next) return null;
  if (todo.next.kind === 'decide')
    return (
      <span
        className={cn(
          'inline-flex h-5 min-w-0 max-w-[55%] shrink items-center gap-1 rounded-full pl-1.5 pr-2 font-medium',
          offline
            ? 'border border-[var(--border-default)] font-normal text-[var(--text-tertiary)]'
            : 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
        )}
      >
        <CircleDot size={12} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{todo.next.label}</span>
      </span>
    );
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-[55%] shrink items-center gap-0.5',
        offline ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]',
      )}
    >
      <ChevronRight size={12} className="shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{todo.next.label}</span>
    </span>
  );
}

function Deadline({
  todo,
  view,
  offline,
}: {
  todo: TeammateTodo;
  view: TodoBoardView;
  offline: boolean;
}) {
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
        offline
          ? 'text-[var(--text-tertiary)]'
          : !deadline
            ? 'text-[var(--text-tertiary)]'
            : overdue
              ? 'font-medium text-[var(--error-fg)]'
              : due
                ? 'font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)]',
      )}
    >
      {due ? <TodoDueDot className={offline ? 'opacity-50' : undefined} /> : null}
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
}: {
  item: TodoBoardItem;
  view: TodoBoardView;
  onOpen: (item: TodoBoardItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const { todo, teammate } = item;
  const offline = teammate.offline;
  const done = view === 'done';
  const completion = todo.history[todo.history.length - 1];
  const doneMeta = [
    teammate.name,
    completion
      ? t('bots.todoBoard.completedOn', { date: shortDate(completion.at, i18n.language) })
      : null,
    completion?.summary,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Tip
      text={tipText(todo, t, i18n.language)}
      side="top"
      contentClassName="max-w-[440px]"
    >
      <button
        type="button"
        data-testid="todo-board-row"
        aria-label={`${todo.title}, ${teammateText(teammate, t)}`}
        onClick={() => onOpen(item)}
        className="flex min-h-8 w-full items-center gap-3 rounded-lg px-2 py-1 text-left outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        <BotAvatar bot={teammate} size="sm" className={offline ? 'opacity-50' : undefined} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-13 leading-5',
              offline || done ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
            )}
          >
            {todo.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-12 leading-4 text-[var(--text-tertiary)]">
            <span className="min-w-0 shrink truncate">
              {done ? doneMeta : metaText(item, t)}
            </span>
            {done ? null : <Next todo={todo} offline={offline} />}
          </span>
        </span>
        {done ? null : <Deadline todo={todo} view={view} offline={offline} />}
      </button>
    </Tip>
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

function TeammatePill({
  pressed,
  onClick,
  teammate,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  teammate?: TodoBoardTeammate;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border pr-2.5 text-12 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        teammate ? 'pl-1.5' : 'pl-2.5',
        pressed
          ? 'border-transparent bg-[var(--surface-chip)] text-[var(--text-primary)]'
          : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]',
      )}
    >
      {teammate ? (
        <BotAvatar bot={teammate} size="xs" />
      ) : pressed ? (
        <Check size={12} aria-hidden />
      ) : null}
      <span>{label}</span>
      {teammate && pressed ? <Check size={12} aria-hidden /> : null}
    </button>
  );
}

/** 离线或读不到的伙伴各说一句，不让清单悄悄少一块。 */
function TeammateNotes({ teammates }: { teammates: readonly TodoBoardTeammate[] }) {
  const { t } = useTranslation();
  const entries = useTodoBoardEntries();
  const notes = teammates.flatMap((teammate) => {
    const entry = entries.get(teammate.key);
    if (teammate.offline) {
      const cached = Boolean(entry && !entry.failed);
      return [
        {
          key: teammate.key,
          text: t(cached ? 'bots.todoBoard.offlineCached' : 'bots.todoBoard.offlineUnknown', {
            name: teammate.name,
            device: teammate.deviceName ?? '',
          }),
          retry: false,
        },
      ];
    }
    return entry?.failed
      ? [
          {
            key: teammate.key,
            text: t('bots.todoBoard.loadFailed', { name: teammate.name }),
            retry: true,
          },
        ]
      : [];
  });
  if (notes.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-1 px-4" data-testid="todo-board-notes">
      {notes.map((note) => (
        <p
          key={note.key}
          className="flex items-center gap-2 text-12 leading-5 text-[var(--text-tertiary)]"
        >
          <span className="min-w-0">{note.text}</span>
          {note.retry ? (
            <button
              type="button"
              onClick={() => refreshTodoBoardEntry(note.key)}
              className="shrink-0 rounded text-[var(--text-secondary)] underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t('commonUi.retry')}
            </button>
          ) : null}
        </p>
      ))}
    </div>
  );
}

export function TeammateTodosView() {
  useOptionalDataOwnerGeneration();
  const { dataOwnerId } = getDataOwnerGeneration();
  return <TodoBoard key={dataOwnerId ?? 'local'} />;
}

const ANY_TEAMMATE: TodoBoardFilter = { teammates: new Set(), origin: 'all' };

/** A label with the number of items it holds, for the segmented controls. */
function counted(label: string, count: number) {
  return {
    label: (
      <>
        {label}
        <span className="ml-1.5 text-12 tabular-nums text-[var(--text-tertiary)]">{count}</span>
      </>
    ),
    'aria-label': `${label} ${count}`,
  };
}

function TodoBoard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const personal = usePersonalTodos();
  const taskTags = usePersonalTaskTags();
  const [editor, setEditor] = useState<PersonalTodo | undefined>(undefined);
  useEffect(() => setEditor(undefined), [personal.dataOwnerId]);
  const teammates = useTodoBoardTeammates();
  const entries = useTodoBoardEntries();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [origin, setOrigin] = useState<TodoBoardOrigin>('all');
  const [view, setView] = useState<TodoBoardView>('open');
  const [tagFilter, setTagFilter] = useState<PersonalTagFilter>(ALL_TAGS);
  const [notice, setNotice] = useState<{
    title: string;
    target: TodoBoardView;
    operation?: string;
  } | null>(null);
  const mine = personal.scope === 'mine';
  const now = new Date();
  const catalog = taskTags.tags;
  const saved = (todo: PersonalTodo, operation?: PersonalTodoUpdate['operation']) => {
    const target =
      todo.status === 'done'
        ? 'done'
        : todo.deferredUntil && Date.parse(todo.deferredUntil) > Date.now()
          ? 'later'
          : 'open';
    setEditor(undefined);
    setNotice({ title: todo.title, target, operation });
    if (operation === 'reopen' || operation === 'restore') {
      personal.selectScope('mine');
      setView('open');
    }
  };
  const updateRow = async (input: PersonalTodoUpdate) =>
    saved(await personal.update(input), input.operation);
  // A todo added from the composer stays visible: a filter that would hide it is cleared.
  const created = (todo: PersonalTodo) => {
    if (!matchesTagFilter(todo, catalog, effectiveTagFilter(tagFilter, catalog)))
      setTagFilter(ALL_TAGS);
  };

  // 伙伴改了名单（归档、换电脑）后，筛选里只留还在的。
  const activeSelection = useMemo(
    () =>
      new Set([...selected].filter((key) => teammates.some((teammate) => teammate.key === key))),
    [selected, teammates],
  );
  const filter = useMemo(() => ({ teammates: activeSelection, origin }), [activeSelection, origin]);
  const teammateItems = useMemo(
    () => todoBoardItems(teammates, entries, view, filter),
    [teammates, entries, view, filter],
  );
  const teammateGroups = useMemo(
    () => (view === 'done' ? [] : groupTodoBoardItems(teammateItems)),
    [teammateItems, view],
  );
  const teammateCounts = useMemo(
    () => ({
      open: todoBoardItems(teammates, entries, 'open', ANY_TEAMMATE).length,
      later: todoBoardItems(teammates, entries, 'later', ANY_TEAMMATE).length,
      done: todoBoardItems(teammates, entries, 'done', ANY_TEAMMATE).length,
    }),
    [teammates, entries],
  );
  const mineCounts = personalCounts(personal.items, now);
  const counts = mine ? mineCounts : teammateCounts;
  const effectiveFilter = effectiveTagFilter(tagFilter, catalog);
  const sections = personalSections({
    items: personal.items,
    view,
    grouping: personal.grouping,
    order: personal.order,
    catalog,
    filter: effectiveFilter,
    now,
  });
  const chips = personalTagChips(personal.items, catalog, effectiveFilter, now);
  const showTag = personal.grouping !== 'tag' && effectiveFilter.kind === 'all';
  const loading = mine
    ? personal.loading
    : teammates.some((teammate) => !teammate.offline && !entries.has(teammate.key));

  const toggleTeammate = (key: string) => {
    setSelected((previous) => {
      const next = new Set([...previous].filter((value) => activeSelection.has(value)));
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const chatTarget =
    teammates.find((teammate) => activeSelection.has(teammate.key)) ?? teammates[0];
  // 同名伙伴（如每台电脑各有一位 Cindy）在筛选里带上电脑名。
  const pillLabel = (teammate: TodoBoardTeammate) =>
    teammate.deviceName &&
    teammates.some((other) => other !== teammate && other.name === teammate.name)
      ? `${teammate.name} · ${teammate.deviceName}`
      : teammate.name;

  const empty = (text: string) => (
    <div
      className="flex flex-col items-center gap-1.5 pb-10 pt-14 text-center"
      data-testid="todo-board-empty"
    >
      <span className="text-13 text-[var(--text-secondary)]">{text}</span>
      {!mine ? (
        <span className="text-12 text-[var(--text-tertiary)]">{t('bots.todoBoard.empty.hint')}</span>
      ) : null}
      {!mine && chatTarget ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2.5"
          onClick={() => navigate(chatTarget.route)}
        >
          {t('bots.todoBoard.empty.chat', { name: chatTarget.name })}
        </Button>
      ) : null}
    </div>
  );

  const sectionLabel = (section: PersonalSection) => {
    const key = section.key;
    if (key.kind === 'bucket') return t(`bots.todoBoard.bucket.${key.bucket}`);
    if (key.kind === 'priority')
      return key.priority
        ? t(`personalTodos.priority.short.${PRIORITY_KEY[key.priority]}`)
        : t('personalTodos.priority.none');
    if (key.kind === 'tag') return key.tag ? tagDisplayName(key.tag, t) : t('personalTodos.untagged');
    return view === 'done' || view === 'later' ? t(`bots.todoBoard.view.${view}`) : t('personalTodos.all');
  };

  let list: ReactNode;
  if (mine) {
    list = sections.length
      ? sections.map((section) => (
          <Section key={section.id} label={sectionLabel(section)} count={section.items.length}>
            {section.items.map((todo) => (
              <PersonalTodoRow
                key={todo.id}
                todo={todo}
                view={view}
                tag={showTag ? resolvePersonalTag(todo, catalog) : null}
                groupBucket={
                  personal.grouping === 'due' && section.key.kind === 'bucket'
                    ? section.key.bucket
                    : undefined
                }
                selected={editor?.id === todo.id}
                now={now}
                onOpen={setEditor}
                onUpdate={updateRow}
              />
            ))}
          </Section>
        ))
      : loading
        ? null
        : empty(t('personalTodos.empty'));
  } else if (view === 'done') {
    list = teammateItems.length ? (
      <Section label={t('bots.todoBoard.view.done')} count={teammateItems.length}>
        {teammateItems.map((item) => (
          <TodoRow
            key={`${item.teammate.key}:${item.todo.id}`}
            item={item}
            view="done"
            onOpen={(entry) => navigate(entry.teammate.route)}
          />
        ))}
      </Section>
    ) : loading ? null : (
      empty(t('bots.todoBoard.empty.done'))
    );
  } else {
    list = teammateGroups.length
      ? teammateGroups.map((group) => (
          <Section
            key={group.bucket}
            label={t(`bots.todoBoard.bucket.${group.bucket}`)}
            count={group.items.length}
          >
            {group.items.map((item) => (
              <TodoRow
                key={`${item.teammate.key}:${item.todo.id}`}
                item={item}
                view={view}
                onOpen={(entry) => navigate(entry.teammate.route)}
              />
            ))}
          </Section>
        ))
      : loading
        ? null
        : empty(t(view === 'later' ? 'bots.todoBoard.empty.later' : 'bots.todoBoard.empty.open'));
  }

  const filterActive = activeSelection.size > 0 || origin !== 'all';
  const showEditor = mine && editor !== undefined;
  return (
    <main
      className="h-full overflow-y-auto pl-4 pr-6 [scrollbar-gutter:stable]"
      data-testid="todo-board"
    >
      <TodoBoardSources teammates={teammates} />
      <div className="mx-auto w-full max-w-[920px] px-1 pb-32 pt-6">
        <div className="flex flex-wrap items-center justify-end gap-3 px-2">
          <h1 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'min-w-0 flex-[1_1_12rem]')}>
            {t('bots.todoBoard.title')}
          </h1>
          <SegmentedControl<TodoBoardView>
            aria-label={t('bots.todoBoard.view.label')}
            value={view}
            onValueChange={setView}
            options={(['open', 'later', 'done'] as const).map((value) => ({
              value,
              ...counted(t(`bots.todoBoard.view.${value}`), counts[value]),
            }))}
          />
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  personal.selectScope('mine');
                  setView(notice.target);
                }}
              >
                {t(`bots.todoBoard.view.${notice.target}`)}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-2 pb-3 pt-4">
          <SegmentedControl<TodoOwnershipView>
            aria-label={t('personalTodos.scope')}
            value={personal.scope}
            onValueChange={(value) => {
              personal.selectScope(value);
              setEditor(undefined);
            }}
            options={(['mine', 'teammates'] as const).map((value) => ({
              value,
              ...counted(
                t(`personalTodos.${value}`),
                value === 'mine' ? mineCounts.open : teammateCounts.open,
              ),
            }))}
          />
          {mine && taskTags.loaded && chips.tags.length > 0 ? (
            <>
              <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-[var(--border-default)]" />
              <PersonalTagChips
                all={chips.all}
                none={chips.none}
                tags={chips.tags}
                filter={effectiveFilter}
                onChange={setTagFilter}
              />
            </>
          ) : null}
          <span className="flex-1" />
          {mine ? (
            <PersonalGroupingMenu
              grouping={personal.grouping}
              order={personal.order}
              onGrouping={personal.selectGrouping}
              onOrder={personal.selectOrder}
            />
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className={chipClass(filterActive)}>
                  <ListFilter size={13} aria-hidden />
                  {t('bots.todoBoard.filter')}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-80 flex-col gap-3">
                {teammates.length > 1 ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-12 text-[var(--text-tertiary)]">
                      {t('bots.todoBoard.filterTeammates')}
                    </span>
                    <div
                      className="flex flex-wrap items-center gap-1.5"
                      role="group"
                      aria-label={t('bots.todoBoard.filterTeammates')}
                    >
                      <TeammatePill
                        pressed={activeSelection.size === 0}
                        onClick={() => setSelected(new Set())}
                        label={t('bots.todoBoard.origin.all')}
                      />
                      {teammates.map((teammate) => (
                        <TeammatePill
                          key={teammate.key}
                          teammate={teammate}
                          label={pillLabel(teammate)}
                          pressed={activeSelection.has(teammate.key)}
                          onClick={() => toggleTeammate(teammate.key)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  <span className="text-12 text-[var(--text-tertiary)]">
                    {t('bots.todoBoard.origin.label')}
                  </span>
                  <SegmentedControl<TodoBoardOrigin>
                    aria-label={t('bots.todoBoard.origin.label')}
                    value={origin}
                    onValueChange={setOrigin}
                    options={(['all', 'assigned', 'discovered'] as const).map((value) => ({
                      value,
                      label: t(`bots.todoBoard.origin.${value}`),
                    }))}
                  />
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {!mine ? <TeammateNotes teammates={teammates} /> : null}
        {mine && personal.failed ? (
          <p role="alert" className="px-4 text-12 text-[var(--error-fg)]">
            {t('personalTodos.loadFailed')}{' '}
            <Button variant="secondary" size="sm" onClick={() => void personal.refresh()}>
              {t('commonUi.retry')}
            </Button>
          </p>
        ) : null}
        <div
          className={cn(
            'mt-1 grid min-w-0 gap-4',
            showEditor && 'min-[1100px]:grid-cols-[minmax(0,1fr)_340px]',
          )}
        >
          {showEditor ? (
            <div className="min-w-0 min-[1100px]:col-start-2 min-[1100px]:row-start-1">
              <PersonalTodoEditor
                key={`${personal.dataOwnerId}:${editor.id}`}
                initial={editor}
                tags={catalog}
                update={personal.update}
                onClose={() => setEditor(undefined)}
                onSaved={saved}
              />
            </div>
          ) : null}
          <div className="min-w-0 min-[1100px]:col-start-1 min-[1100px]:row-start-1">
            {mine && view === 'open' ? (
              <PersonalTodoComposer
                update={personal.update}
                tags={catalog}
                supportedColors={taskTags.supportedColors}
                createTag={taskTags.create}
                activeTagId={effectiveFilter.kind === 'tag' ? effectiveFilter.id : null}
                onCreated={created}
              />
            ) : null}
            {mine && personal.failed && !personal.items.length ? null : list}
          </div>
        </div>
      </div>
    </main>
  );
}
