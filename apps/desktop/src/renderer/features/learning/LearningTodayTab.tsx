/**
 * 对话右侧的「今天」页签：只在绑定了进行中学习目标的导师对话里出现（按 Session id 绑定），
 * 显示当前知识点、开着的题（只有题面）、今天的作答、折叠大纲，以及三句快捷话。快捷话只写进
 * 这场对话的输入框，由用户按发送；页签本身不发消息、不改目标。
 */
import { useState } from 'react';
import { BookOpenText, CircleCheck, MessageCircleQuestion, Play, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { insertPromptIntoComposer } from '@/lib/composerActionsBus';
import type { TabKindBodyProps } from '@/features/right-sidebar/types';
import type { LearningGoal } from '../../../shared/learning';
import { MiniOutline, pointStateLabel } from './learningVisuals';
import { useLearningSnapshot } from './useLearningSnapshot';

export const LEARNING_TODAY_TAB_KIND = 'learning-today' as const;

/** The goal bound to this conversation, when the conversation runs on this computer. */
export function useBoundGoal(sessionId: string): LearningGoal | null {
  const { snapshot } = useLearningSnapshot();
  const binding = snapshot?.bindings[sessionId];
  return (binding && snapshot?.goals.find((goal) => goal.id === binding.goalId)) || null;
}

function Section({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <div className="py-3 [&+&]:border-t [&+&]:border-[var(--border-default)]">
      <h3 className="flex items-center justify-between pb-1.5 text-12 font-normal leading-4 text-[var(--text-tertiary)]">
        <span>{label}</span>
        {value ? <span>{value}</span> : null}
      </h3>
      {children}
    </div>
  );
}

function TodayBody({ goal, sessionId }: { goal: LearningGoal; sessionId: string }) {
  const { t } = useTranslation();
  const [prefillFailed, setPrefillFailed] = useState(false);
  const moduleIndex = goal.modules.findIndex((module) => module.id === goal.current?.moduleId);
  const module = goal.modules[moduleIndex];
  const point = module?.points.find((candidate) => candidate.id === goal.current?.pointId);
  const say = (key: 'continue' | 'explainFirst' | 'anotherQuestion') => {
    setPrefillFailed(!insertPromptIntoComposer({ targetSessionId: sessionId, text: t(`learning.tab.say.${key}`) }));
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1">
        <Section label={t('learning.tab.currentPoint')} value={point ? pointStateLabel(t, point.state) : undefined}>
          {module ? (
            <p className="text-12 leading-4 text-[var(--text-secondary)]">
              {t('learning.moduleNumber', { number: moduleIndex + 1 })} · {module.name}
            </p>
          ) : null}
          <p className="text-13 leading-5 text-[var(--text-primary)]">{point?.name ?? t('learning.allCleared')}</p>
        </Section>
        <Section label={t('learning.tab.waiting')} value={goal.openQuestion ? '1' : '0'}>
          {goal.openQuestion ? (
            <div className="rounded-lg bg-[var(--surface-chip)] px-3 py-2.5 text-13 leading-5 text-[var(--text-primary)]">
              <p className="whitespace-pre-line">{goal.openQuestion.prompt}</p>
              {goal.openQuestion.options.length ? (
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {goal.openQuestion.options.map((option) => (
                    <li key={`${option.label}-${option.body}`}>
                      {option.label ? `${option.label}. ` : ''}
                      {option.body}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="text-13 leading-5 text-[var(--text-secondary)]">{t('learning.noOpenQuestion')}</p>
          )}
        </Section>
        <Section label={t('learning.tab.doneToday')}>
          <p className="flex items-start gap-2 py-0.5 text-13 leading-5">
            <MessageCircleQuestion size={14} aria-hidden className="mt-[3px] shrink-0 text-[var(--text-primary)]" />
            <span className="min-w-0">{t('learning.tab.answered')}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[var(--text-secondary)]">{goal.today.attempts}</span>
          </p>
          <p className="flex items-start gap-2 py-0.5 text-13 leading-5">
            <CircleCheck size={14} aria-hidden className="mt-[3px] shrink-0 text-[var(--text-primary)]" />
            <span className="min-w-0">{t('learning.tab.correct')}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[var(--text-secondary)]">{goal.today.correct}</span>
          </p>
        </Section>
        <Section label={t('learning.outline')} value={`${goal.masteredCount} / ${goal.totalCount}`}>
          <MiniOutline goal={goal} />
        </Section>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-[var(--border-default)] px-4 py-3">
        <Button size="sm" compact variant="primary" onClick={() => say('continue')}>
          <Play size={13} aria-hidden />
          {t('learning.tab.continue')}
        </Button>
        <Button size="sm" compact variant="secondary" onClick={() => say('explainFirst')}>
          <BookOpenText size={13} aria-hidden />
          {t('learning.tab.explainFirst')}
        </Button>
        <Button
          size="sm"
          compact
          variant="secondary"
          disabled={!goal.openQuestion}
          title={goal.openQuestion ? undefined : t('learning.noOpenQuestion')}
          onClick={() => say('anotherQuestion')}
        >
          <RefreshCw size={13} aria-hidden />
          {t('learning.tab.anotherQuestion')}
        </Button>
        {prefillFailed ? (
          <p role="status" className="w-full text-12 leading-4 text-[var(--text-secondary)]">
            {t('learning.tab.prefillFailed')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function LearningTodayTabBody({ ctx }: TabKindBodyProps<Record<never, never>>) {
  const { t } = useTranslation();
  const goal = useBoundGoal(ctx.sessionId);
  // Unknown owner (undefined) shows nothing; a remote conversation's goals live on that computer.
  if (ctx.deviceLinkDeviceId === undefined) return null;
  if (ctx.remoteHostId || ctx.deviceLinkDeviceId !== null)
    return <p className="px-4 py-6 text-13 leading-5 text-[var(--text-secondary)]">{t('learning.tab.localOnly')}</p>;
  if (!goal || goal.status !== 'active')
    return <p className="px-4 py-6 text-13 leading-5 text-[var(--text-secondary)]">{t('learning.tab.unbound')}</p>;
  return <TodayBody goal={goal} sessionId={ctx.sessionId} />;
}
