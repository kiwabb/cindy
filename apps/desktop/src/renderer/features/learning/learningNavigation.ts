import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useBotProfiles } from '@/features/bots/botStore';

import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import type { LearningGoal, LearningSnapshot } from '../../../shared/learning';

/**
 * Opens a tutor conversation by Session id with the same route every other entry uses (a teammate
 * conversation opens in the teammate view). A goal with no bound conversation opens its teammate.
 */
export function useOpenLearningConversation() {
  const navigate = useNavigate();
  return useCallback(
    async (target: { sessionId?: string | null; botId?: string | null }) => {
      if (target.sessionId) {
        navigate(await resolveSessionRoute(target.sessionId));
        return;
      }
      navigate(target.botId ? `/bots/${encodeURIComponent(target.botId)}` : '/bots');
    },
    [navigate],
  );
}

export const goalConversation = (goal: LearningGoal) => ({
  sessionId: goal.sessionIds[0] ?? null,
  botId: goal.botId,
});

/** The tutor teammate's own name for buttons such as "open the tutor conversation". */
export function useTutorName(botId: string | null | undefined): string {
  const { t } = useTranslation();
  const bots = useBotProfiles();
  return bots.find((bot) => bot.id === botId)?.name || t('learning.tutorFallback');
}

/** The teammate to start a goal with: the one that kept the most recent goal. */
export function tutorBotId(snapshot: LearningSnapshot | null): string | null {
  return snapshot?.goals[0]?.botId ?? null;
}

export function formatDay(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', weekday: 'short' }).format(at);
}

export function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function endOfLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}
