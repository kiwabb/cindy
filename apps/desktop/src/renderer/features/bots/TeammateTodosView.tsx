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
import { PRIORITY_KEY, tagDisplayName } from './personalTodoVisuals';
import { PersonalTodoEditor, usePersonalTodos } from './personalTodos';
import { usePersonalTaskTags } from './usePersonalTaskTags';
import type { PersonalTodo, PersonalTodoUpdate } from '../../../shared/personalTodo';
/**
 * 内置待办页：只管理当前账号的个人待办（行内新增、分组、标签筛选、详情面板）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SETTINGS_SECTION_TITLE_CLASS } from '@/components/ui/settings-rows';
import { cn } from '@/lib/utils';
import type { TodoBoardView } from './teammateTodoBoard';

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
  const personal = usePersonalTodos();
  const taskTags = usePersonalTaskTags();
  const [editor, setEditor] = useState<PersonalTodo | undefined>(undefined);
  useEffect(() => setEditor(undefined), [personal.dataOwnerId]);
  const [view, setView] = useState<TodoBoardView>('open');
  const [tagFilter, setTagFilter] = useState<PersonalTagFilter>(ALL_TAGS);
  const [notice, setNotice] = useState<{
    title: string;
    target: TodoBoardView;
    operation?: string;
  } | null>(null);
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
    if (operation === 'reopen' || operation === 'restore') setView('open');
  };
  const updateRow = async (input: PersonalTodoUpdate) =>
    saved(await personal.update(input), input.operation);
  // A todo added from the composer stays visible: a filter that would hide it is cleared.
  const created = (todo: PersonalTodo) => {
    if (!matchesTagFilter(todo, catalog, effectiveTagFilter(tagFilter, catalog)))
      setTagFilter(ALL_TAGS);
  };

  const counts = personalCounts(personal.items, now);
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

  const empty = (text: string) => (
    <div
      className="flex flex-col items-center gap-1.5 pb-10 pt-14 text-center"
      data-testid="todo-board-empty"
    >
      <span className="text-13 text-[var(--text-secondary)]">{text}</span>
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

  const list: ReactNode = sections.length
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
    : personal.loading
      ? null
      : empty(t('personalTodos.empty'));

  const showEditor = editor !== undefined;
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
              <Button variant="secondary" size="sm" onClick={() => setView(notice.target)}>
                {t(`bots.todoBoard.view.${notice.target}`)}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-2 pb-3 pt-4">
          {taskTags.loaded && chips.tags.length > 0 ? (
            <PersonalTagChips
              all={chips.all}
              none={chips.none}
              tags={chips.tags}
              filter={effectiveFilter}
              onChange={setTagFilter}
            />
          ) : null}
          <span className="flex-1" />
          <PersonalGroupingMenu
            grouping={personal.grouping}
            order={personal.order}
            onGrouping={personal.selectGrouping}
            onOrder={personal.selectOrder}
          />
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
            {view === 'open' ? (
              <PersonalTodoComposer
                update={personal.update}
                tags={catalog}
                supportedColors={taskTags.supportedColors}
                createTag={taskTags.create}
                activeTagId={effectiveFilter.kind === 'tag' ? effectiveFilter.id : null}
                onCreated={created}
              />
            ) : null}
            {personal.failed && !personal.items.length ? null : list}
          </div>
        </div>
      </div>
    </main>
  );
}
