/**
 * Shared pieces of the Learning page and the Today tab: point state icons, the read-only badge,
 * the progress bar, the daily time bar and the outline rows. Colours come only from semantic
 * tokens (neutral greys, like the quota bar), so light and dark follow the theme.
 */
import { useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  Headphones,
  Mic,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { cn } from '@/lib/utils';
import type {
  LearningCheckLimit,
  LearningDailyPlan,
  LearningGoal,
  LearningModule,
  LearningPoint,
  LearningPointState,
} from '../../../shared/learning';

const STATE_ICON: Record<LearningPointState, LucideIcon> = {
  'not-started': Circle,
  'in-progress': CircleDot,
  mastered: CircleCheck,
  deferred: CirclePause,
  'self-reported': UserCheck,
};

export function PointStateIcon({ state, size = 16 }: { state: LearningPointState; size?: number }) {
  const Icon = STATE_ICON[state];
  return <Icon size={size} aria-hidden className="shrink-0" />;
}

export const pointStateLabel = (t: TFunction, state: LearningPointState) =>
  t(`learning.pointState.${state}`);

export function pointTypeLabel(t: TFunction, point: LearningPoint): string | null {
  return point.type === 'other' ? null : t(`learning.pointType.${point.type}`);
}

const LIMIT_ICON: Record<LearningCheckLimit, LucideIcon> = { audio: Headphones, speech: Mic };

/** Small read-only badge (new component: 22px, no border, chip surface). */
export function Badge({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--surface-chip)] px-2 text-12 leading-4',
        strong ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
      )}
    >
      {children}
    </span>
  );
}

export function CheckLimitBadge({ limit }: { limit: LearningCheckLimit }) {
  const { t } = useTranslation();
  const Icon = LIMIT_ICON[limit];
  return (
    <Badge>
      <Icon size={12} aria-hidden />
      {t(`learning.checkLimit.${limit}`)}
    </Badge>
  );
}

/** Neutral progress bar (new component; same tokens as the quota bar). */
export function ProgressBar({ value, total, label, className }: { value: number; total: number; label: string; className?: string }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('block h-1.5 overflow-hidden rounded-full bg-[var(--quota-bar-track)]', className)}
    >
      <span
        className="block h-1.5 rounded-full bg-[var(--quota-bar-fill)]"
        style={{ width: `${ratio * 100}%` }}
      />
    </span>
  );
}

/** The day's four-part time bar (new component). Shown only when the tutor wrote a plan. */
export function DailyPlanBar({ plan, now }: { plan: LearningDailyPlan; now: 'explain' | 'practice' | null }) {
  const { t } = useTranslation();
  if (!plan.segments.length) return null;
  const label = plan.segments
    .map((segment) => t('learning.plan.segmentAria', { name: t(`learning.plan.${segment.kind}`), count: segment.minutes }))
    .join(t('learning.plan.joiner'));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-12 leading-4 text-[var(--text-secondary)]">
        <span>{t('learning.plan.title')}</span>
        <span className="tabular-nums">{t('learning.minutes', { count: plan.minutes })}</span>
      </div>
      <div role="img" aria-label={label} className="flex h-1.5 gap-[3px]">
        {plan.segments.map((segment, index) => (
          <span
            key={`${segment.kind}-${index}`}
            className={cn(
              'h-1.5 min-w-0 rounded-full',
              segment.kind === now ? 'bg-[var(--quota-bar-fill)]' : 'bg-[var(--quota-bar-track)]',
            )}
            style={{ flex: `${segment.minutes} 1 0` }}
          />
        ))}
      </div>
      <div aria-hidden className="flex gap-[3px] text-12 leading-4 tabular-nums text-[var(--text-tertiary)]">
        {plan.segments.map((segment, index) => (
          <span
            key={`${segment.kind}-${index}`}
            className={cn(
              'min-w-0 overflow-hidden whitespace-nowrap',
              segment.kind === now && 'font-medium text-[var(--text-primary)]',
            )}
            style={{ flex: `${segment.minutes} 1 0` }}
          >
            {t(`learning.plan.${segment.kind}`)} {segment.minutes}
          </span>
        ))}
      </div>
    </div>
  );
}

export const clearedCount = (module: LearningModule) =>
  module.points.filter((point) => point.state === 'mastered' || point.state === 'self-reported').length;

/** A module heading that folds its points (outline rows with a state icon: new component). */
function ModuleHeading({
  open,
  onToggle,
  children,
  count,
  compact,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  count: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        compact
          ? 'min-h-7 gap-1.5 px-1.5 text-12 leading-4 text-[var(--text-secondary)]'
          : 'min-h-8 px-2 py-1 text-13 leading-5',
      )}
    >
      <ChevronRight
        size={12}
        aria-hidden
        className={cn('shrink-0 text-[var(--text-secondary)] transition-transform', open && 'rotate-90')}
      />
      {children}
      <span className="shrink-0 text-12 tabular-nums text-[var(--text-tertiary)]">{count}</span>
    </button>
  );
}

/** The full outline of a goal on the Learning page. */
export function GoalOutline({ goal }: { goal: LearningGoal }) {
  const { t } = useTranslation();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="flex flex-col gap-1">
      {goal.modules.map((module, index) => {
        const open = !closed.has(module.id);
        return (
          <div key={module.id}>
            <ModuleHeading
              open={open}
              count={`${clearedCount(module)} / ${module.points.length}`}
              onToggle={() =>
                setClosed((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(module.id);
                  else next.delete(module.id);
                  return next;
                })
              }
            >
              <span className="shrink-0 text-[var(--text-tertiary)]">
                {t('learning.moduleNumber', { number: index + 1 })}
              </span>
              <span className="min-w-0 flex-1 font-medium">{module.name}</span>
            </ModuleHeading>
            {open ? (
              <ul className="flex flex-col">
                {module.points.map((point) => {
                  const current = goal.current?.pointId === point.id;
                  const strong = current || point.state === 'mastered';
                  const type = pointTypeLabel(t, point);
                  return (
                    <li
                      key={point.id}
                      aria-current={current ? 'step' : undefined}
                      className={cn(
                        'ml-3 flex flex-wrap items-start gap-x-2.5 gap-y-1 rounded-lg px-2 py-1.5',
                        current && 'bg-[var(--surface-chip)]',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-5 items-center',
                          strong ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                        )}
                      >
                        <PointStateIcon state={point.state} />
                      </span>
                      <span className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
                        <span
                          className={cn(
                            'text-13 leading-5',
                            point.state === 'not-started'
                              ? 'text-[var(--text-secondary-mid)]'
                              : 'text-[var(--text-primary)]',
                          )}
                        >
                          {point.name}
                        </span>
                        {point.checkLimits.length ? (
                          <span className="flex flex-wrap gap-1.5">
                            {point.checkLimits.map((limit) => (
                              <CheckLimitBadge key={limit} limit={limit} />
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex h-5 shrink-0 items-center gap-2.5 whitespace-nowrap text-12 leading-4 text-[var(--text-tertiary)]">
                        {type ? <span>{type}</span> : null}
                        <span
                          className={cn(
                            'min-w-[4em] text-right',
                            strong ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                          )}
                        >
                          {pointStateLabel(t, point.state)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The folded outline in the Today tab: only the module being learned starts open. */
export function MiniOutline({ goal }: { goal: LearningGoal }) {
  const { t } = useTranslation();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
    () => new Set(goal.current ? [goal.current.moduleId] : goal.modules.slice(0, 1).map((m) => m.id)),
  );
  return (
    <div className="flex flex-col gap-0.5">
      {goal.modules.map((module, index) => {
        const open = openIds.has(module.id);
        return (
          <div key={module.id}>
            <ModuleHeading
              compact
              open={open}
              count={`${clearedCount(module)} / ${module.points.length}`}
              onToggle={() =>
                setOpenIds((previous) => {
                  const next = new Set(previous);
                  if (open) next.delete(module.id);
                  else next.add(module.id);
                  return next;
                })
              }
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {index + 1} · {module.name}
              </span>
            </ModuleHeading>
            {open ? (
              <ul className="flex flex-col">
                {module.points.map((point) => {
                  const current = goal.current?.pointId === point.id;
                  const done = point.state === 'mastered' || point.state === 'self-reported';
                  return (
                    <li
                      key={point.id}
                      aria-current={current ? 'step' : undefined}
                      className={cn(
                        'ml-3 flex h-7 items-center gap-2 rounded-lg px-1.5 text-12 leading-4',
                        current
                          ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                          : done
                            ? 'text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)]',
                      )}
                    >
                      <span className="sr-only">{pointStateLabel(t, point.state)}</span>
                      <PointStateIcon state={point.state} size={14} />
                      <span title={point.name} className="min-w-0 flex-1 truncate">
                        {point.name}
                      </span>
                      {point.checkLimits.map((limit) => {
                        const Icon = LIMIT_ICON[limit];
                        return (
                          <Icon key={limit} size={12} role="img" aria-label={t(`learning.checkLimit.${limit}`)} className="shrink-0" />
                        );
                      })}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
