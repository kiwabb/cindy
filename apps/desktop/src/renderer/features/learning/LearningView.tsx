/**
 * 「学习」页：导师伙伴的学习目标，只读。今天学什么、每个目标的大纲与进度、关于你、复习排期；
 * 修改目标、大纲或画像都回到导师对话里说。数据来自主进程对导师目标文件的只读投影。
 */
import { useState } from 'react';
import {
  CalendarClock,
  ChevronRight,
  GraduationCap,
  Lock,
  MessageCircleQuestion,
  MessageSquareShare,
  Play,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import { SETTINGS_SECTION_TITLE_CLASS } from '@/components/ui/settings-rows';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { LearningGoal } from '../../../shared/learning';
import {
  endOfLocalDay,
  formatDay,
  goalConversation,
  isSameLocalDay,
  tutorBotId,
  useOpenLearningConversation,
  useTutorName,
} from './learningNavigation';
import { Badge, DailyPlanBar, GoalOutline, ProgressBar } from './learningVisuals';
import { refreshLearningSnapshot, useLearningSnapshot } from './useLearningSnapshot';

export function LearningView() {
  useOptionalDataOwnerGeneration();
  const { dataOwnerId } = getDataOwnerGeneration();
  return <LearningPage key={dataOwnerId ?? 'local'} />;
}

function SectionLabel({ label, value }: { label: string; value?: string }) {
  return (
    <h2 className="flex items-center justify-between px-2 pb-1.5 pt-5 text-12 font-normal leading-4 text-[var(--text-tertiary)]">
      <span>{label}</span>
      {value ? <span className="tabular-nums">{value}</span> : null}
    </h2>
  );
}

function useActivityText() {
  const { t, i18n } = useTranslation();
  return (at: number | null) => {
    if (at === null) return '';
    if (isSameLocalDay(at, Date.now()))
      return t('learning.todayAt', {
        time: new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(at),
      });
    return formatDay(at, i18n.language);
  };
}

function TodayCard({ goal }: { goal: LearningGoal }) {
  const { t, i18n } = useTranslation();
  const open = useOpenLearningConversation();
  const moduleIndex = goal.modules.findIndex((module) => module.id === goal.current?.moduleId);
  const module = goal.modules[moduleIndex];
  const point = module?.points.find((candidate) => candidate.id === goal.current?.pointId);
  const endOfToday = endOfLocalDay(Date.now());
  const dueToday = goal.reviews.filter((review) => review.dueAt < endOfToday).length;
  const nextReview = goal.reviews.find((review) => review.dueAt >= endOfToday);
  return (
    <section
      aria-label={goal.name}
      className="flex flex-col gap-3.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4"
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
          <p className="flex flex-wrap items-center gap-1.5 text-12 leading-4 text-[var(--text-secondary)]">
            <strong className="font-medium text-[var(--text-primary)]">{goal.name}</strong>
            {module ? (
              <span>
                {t('learning.moduleNumber', { number: moduleIndex + 1 })} · {module.name}
              </span>
            ) : null}
          </p>
          <p className="text-14 leading-5 text-[var(--text-primary)]">
            {point?.name ?? t('learning.allCleared')}
          </p>
        </div>
        <Button variant="cta" onClick={() => void open(goalConversation(goal))}>
          <Play size={13} aria-hidden />
          {t('learning.goStudy')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {goal.step ? (
          <Badge strong>{t('learning.stepAt', { step: t(`learning.step.${goal.step}`) })}</Badge>
        ) : null}
        {goal.openQuestion ? (
          <Badge strong>
            <MessageCircleQuestion size={12} aria-hidden />
            {t('learning.openQuestion', { count: 1 })}
          </Badge>
        ) : (
          <Badge>
            <MessageCircleQuestion size={12} aria-hidden />
            {t('learning.noOpenQuestion')}
          </Badge>
        )}
        <Badge>
          <CalendarClock size={12} aria-hidden />
          {t('learning.dueToday', { count: dueToday })}
        </Badge>
        {nextReview ? (
          <Badge>{t('learning.nextReview', { date: formatDay(nextReview.dueAt, i18n.language) })}</Badge>
        ) : null}
      </div>
      {goal.dailyPlan ? <DailyPlanBar plan={goal.dailyPlan} now={goal.step} /> : null}
    </section>
  );
}

function GoalCard({ goal, defaultOpen }: { goal: LearningGoal; defaultOpen: boolean }) {
  const { t, i18n } = useTranslation();
  const open = useOpenLearningConversation();
  const activity = useActivityText();
  const tutor = useTutorName(goal.botId);
  const [expanded, setExpanded] = useState(defaultOpen);
  const detailId = `learning-goal-${goal.id}`;
  const profile = (
    [
      ['priorKnowledge', goal.profile.priorKnowledge],
      ['targetLevel', goal.profile.targetLevel],
      ['timeBudget', goal.profile.timeBudget],
      ['preferences', goal.profile.preferences],
    ] as const
  ).filter(([, value]) => value);
  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded((value) => !value)}
          className="-m-1 -mx-2 flex min-w-0 flex-[1_1_260px] items-center gap-3 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={cn('shrink-0 text-[var(--text-secondary)] transition-transform', expanded && 'rotate-90')}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-16 font-medium leading-6 text-[var(--text-primary)]">{goal.name}</span>
            {goal.quote ? (
              <span className="text-13 leading-5 text-[var(--text-secondary)]">
                {t('learning.goalQuote', { quote: goal.quote })}
              </span>
            ) : null}
          </span>
        </button>
        {goal.outlineAgreed ? null : (
          <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-12 leading-4 text-[var(--text-secondary)]">
            {t('learning.outlineDraft')}
            <Button variant="secondary" size="xs" compact onClick={() => void open(goalConversation(goal))}>
              {t('learning.finalizeOutline')}
            </Button>
          </span>
        )}
        <span className="flex min-w-[180px] flex-[0_1_260px] flex-col gap-1.5">
          <span className="flex justify-between gap-3 text-12 leading-4 tabular-nums text-[var(--text-secondary)]">
            <span>
              {t('learning.masteredLabel')}{' '}
              <strong className="font-medium text-[var(--text-primary)]">{goal.masteredCount}</strong> /{' '}
              {goal.totalCount}
            </span>
            {goal.lastActivityAt ? (
              <span>{t('learning.lastActivity', { when: activity(goal.lastActivityAt) })}</span>
            ) : null}
          </span>
          <ProgressBar
            value={goal.masteredCount}
            total={goal.totalCount}
            label={t('learning.masteredAria', { count: goal.masteredCount, total: goal.totalCount })}
          />
        </span>
      </div>
      {expanded ? (
        <div id={detailId} className="border-t border-[var(--border-default)] px-4 pb-4 pt-1">
          <h3 className="flex items-center gap-1.5 pb-1.5 pt-3.5 text-13 font-medium leading-5 text-[var(--text-secondary)]">
            {t('learning.outline')}
            <span className="ml-auto text-12 font-normal text-[var(--text-tertiary)]">
              {t('learning.outlineSize', { modules: goal.modules.length, points: goal.totalCount })}
            </span>
          </h3>
          <GoalOutline goal={goal} />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8">
            <div>
              <h3 className="flex items-center gap-1.5 pb-1.5 pt-3.5 text-13 font-medium leading-5 text-[var(--text-secondary)]">
                {t('learning.aboutYou')}
                <span className="ml-auto inline-flex items-center gap-1 text-12 font-normal text-[var(--text-tertiary)]">
                  <Lock size={12} aria-hidden />
                  {t('learning.readOnly')}
                </span>
              </h3>
              {profile.length ? (
                <dl className="grid grid-cols-[5em_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-13 leading-5">
                  {profile.map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-[var(--text-secondary)]">{t(`learning.profile.${key}`)}</dt>
                      <dd className="text-[var(--text-primary)]">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className="pt-2.5 text-12 leading-4 text-[var(--text-tertiary)]">{t('learning.profileNote', { name: tutor })}</p>
            </div>
            <div>
              <h3 className="flex items-center gap-1.5 pb-1.5 pt-3.5 text-13 font-medium leading-5 text-[var(--text-secondary)]">
                {t('learning.reviews')}
                <span className="ml-auto text-12 font-normal tabular-nums text-[var(--text-tertiary)]">
                  {goal.reviews.length}
                </span>
              </h3>
              {goal.reviews.length ? (
                <ul>
                  {goal.reviews.map((review) => (
                    <li key={review.pointId} className="flex items-start gap-3 py-1 text-13 leading-5">
                      <span className="w-[7.5em] shrink-0 tabular-nums text-[var(--text-primary)]">
                        {formatDay(review.dueAt, i18n.language)}
                      </span>
                      <span className="min-w-0 flex-1 text-[var(--text-secondary-mid)]">{review.pointName}</span>
                      <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                        {t('learning.reviewedTimes', { count: review.reviewCount })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-13 leading-5 text-[var(--text-secondary)]">{t('learning.noReviews')}</p>
              )}
            </div>
          </div>
          <div className="flex justify-end pt-4">
            <Button variant="secondary" onClick={() => void open(goalConversation(goal))}>
              <MessageSquareShare size={14} aria-hidden />
              {t('learning.openConversation', { name: tutor })}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ArchivedGoals({ goals }: { goals: LearningGoal[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!goals.length) return null;
  return (
    <div className="mt-5 px-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="learning-archived"
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex min-h-8 w-[calc(100%+16px)] items-center gap-2 rounded-lg px-2 py-1 text-left text-13 leading-5 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <ChevronRight size={12} aria-hidden className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">{t('learning.archived')}</span>
        <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{goals.length}</span>
      </button>
      {open ? (
        <ul id="learning-archived">
          {goals.map((goal) => (
            <li
              key={goal.id}
              className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5 pl-5 pr-2 text-13 leading-5"
            >
              <span className="min-w-0 flex-[1_1_160px] text-[var(--text-secondary-mid)]">{goal.name}</span>
              <span className="inline-flex items-center gap-1 text-12 text-[var(--text-tertiary)]">
                <Lock size={12} aria-hidden />
                {t('learning.readOnly')}
              </span>
              <span className="text-12 tabular-nums text-[var(--text-secondary)]">
                {t('learning.masteredLabel')} {goal.masteredCount} / {goal.totalCount}
              </span>
              <ProgressBar
                className="w-[120px] shrink-0"
                value={goal.masteredCount}
                total={goal.totalCount}
                label={t('learning.masteredAria', { count: goal.masteredCount, total: goal.totalCount })}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LearningPage() {
  const { t, i18n } = useTranslation();
  const { snapshot, failed } = useLearningSnapshot();
  const open = useOpenLearningConversation();
  const active = snapshot?.goals.filter((goal) => goal.status === 'active') ?? [];
  const archived = snapshot?.goals.filter((goal) => goal.status === 'archived') ?? [];
  const today = active.filter((goal) => goal.current);
  const tutor = useTutorName(tutorBotId(snapshot));
  return (
    <main className="h-full overflow-y-auto pl-4 pr-6 [scrollbar-gutter:stable]" data-testid="learning-page">
      <div className="mx-auto w-full max-w-[920px] px-1 pb-32 pt-6">
        <div className="flex flex-wrap items-center justify-end gap-3 px-2">
          <h1 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'min-w-0 flex-[1_1_12rem]')}>{t('learning.title')}</h1>
        </div>
        {!snapshot ? (
          failed ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-4 pt-24 text-13 text-[var(--text-secondary)]">
              {t('learning.loadFailed')}
              <Button variant="secondary" onClick={() => void refreshLearningSnapshot()}>
                {t('commonUi.retry')}
              </Button>
            </div>
          ) : (
            <div className="flex justify-center pt-24">
              <Spinner size={20} className="text-[var(--text-tertiary)]" role="status" aria-label={t('ccAgent.common.loading')} />
            </div>
          )
        ) : active.length === 0 ? (
          <>
            <div className="flex flex-col items-center gap-2 px-4 pb-10 pt-24 text-center">
              <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
                <GraduationCap size={20} strokeWidth={1.6} aria-hidden />
              </span>
              <p className="text-14 font-medium leading-5 text-[var(--text-primary)]">{t('learning.empty.title')}</p>
              <p className="max-w-[28em] pb-2 text-13 leading-5 text-[var(--text-secondary)]">{t('learning.empty.body', { name: tutor })}</p>
              <Button variant="cta" onClick={() => void open({ botId: tutorBotId(snapshot) })}>
                {t('learning.empty.action', { name: tutor })}
              </Button>
            </div>
            <ArchivedGoals goals={archived} />
          </>
        ) : (
          <>
            {today.length ? (
              <>
                <SectionLabel label={t('learning.today')} value={formatDay(Date.now(), i18n.language)} />
                <div className="flex flex-col gap-3">
                  {today.map((goal) => (
                    <TodayCard key={goal.id} goal={goal} />
                  ))}
                </div>
              </>
            ) : null}
            <SectionLabel label={t('learning.goals')} value={String(active.length)} />
            <div className="flex flex-col gap-3">
              {active.map((goal, index) => (
                <GoalCard key={goal.id} goal={goal} defaultOpen={index === 0} />
              ))}
            </div>
            <ArchivedGoals goals={archived} />
          </>
        )}
      </div>
    </main>
  );
}
