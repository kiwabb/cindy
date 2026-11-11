import { ArrowUpDown, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TaskTag } from '@cindy/maker-shared';
import {
  PERSONAL_GROUPINGS,
  PERSONAL_ORDERS,
  type PersonalGrouping,
  type PersonalOrder,
  type PersonalTagFilter,
  type TagChip,
} from './personalTodoModel';
import { Count, TagDot, chipClass, tagDisplayName } from './personalTodoVisuals';

type Chip = { key: string; filter: PersonalTagFilter; label: string; count: number; tag?: TaskTag };

/** 全部 / each tag with open todos / 无标签: a single-choice filter written as pressed buttons. */
export function PersonalTagChips({
  all,
  none,
  tags,
  filter,
  onChange,
}: {
  all: number;
  none: number;
  tags: readonly TagChip[];
  filter: PersonalTagFilter;
  onChange: (filter: PersonalTagFilter) => void;
}) {
  const { t } = useTranslation();
  const chips: Chip[] = [
    { key: 'all', filter: { kind: 'all' }, label: t('personalTodos.all'), count: all },
    ...tags.map(({ tag, count }) => ({
      key: tag.id,
      filter: { kind: 'tag', id: tag.id } as const,
      label: tagDisplayName(tag, t),
      count,
      tag,
    })),
    ...(none > 0 || filter.kind === 'none'
      ? [{ key: 'none', filter: { kind: 'none' } as const, label: t('personalTodos.untagged'), count: none }]
      : []),
  ];
  const active = (chip: Chip) =>
    chip.filter.kind === filter.kind &&
    (chip.filter.kind !== 'tag' || (filter.kind === 'tag' && filter.id === chip.filter.id));
  return (
    <div role="group" aria-label={t('taskTags.title')} className="flex min-w-0 flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          aria-pressed={active(chip)}
          onClick={() => onChange(chip.filter)}
          className={chipClass(active(chip))}
        >
          {chip.tag ? <TagDot color={chip.tag.color} /> : null}
          <span className="max-w-40 truncate">{chip.label}</span>
          <Count value={chip.count} />
        </button>
      ))}
    </div>
  );
}

/** The button on the right of the toolbar: grouping, and the order inside a group. */
export function PersonalGroupingMenu({
  grouping,
  order,
  onGrouping,
  onOrder,
}: {
  grouping: PersonalGrouping;
  order: PersonalOrder;
  onGrouping: (value: PersonalGrouping) => void;
  onOrder: (value: PersonalOrder) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass(false, 'pl-3 pr-2.5 text-[var(--text-primary)]')}>
          <ArrowUpDown size={13} aria-hidden />
          {t(`personalTodos.group.${grouping}`)}
          <ChevronDown size={12} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('personalTodos.group.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={grouping}
          onValueChange={(value) => onGrouping(value as PersonalGrouping)}
        >
          {PERSONAL_GROUPINGS.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {t(`personalTodos.group.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('personalTodos.order.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={order} onValueChange={(value) => onOrder(value as PersonalOrder)}>
          {PERSONAL_ORDERS.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {t(`personalTodos.order.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
