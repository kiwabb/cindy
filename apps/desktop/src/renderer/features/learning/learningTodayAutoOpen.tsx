/**
 * Adds the Today tab beside a tutor conversation. Kept apart from the tab body so the body does
 * not load the right-sidebar store.
 */
import { useEffect } from 'react';

import { addTab, ensureHydrated, getBucket } from '@/features/right-sidebar/store';
import { LEARNING_TODAY_TAB_KIND, useBoundGoal } from './LearningTodayTab';

const autoOpened = new Set<string>();

/**
 * Adds the Today tab (without focusing it or opening the sidebar) the first time this run a
 * conversation on this computer turns out to be bound to an active learning goal. Closing the tab
 * keeps it closed until the next launch.
 */
export function LearningTodayTabAutoOpen({
  sessionId,
  remoteHostId,
  deviceLinkDeviceId,
}: {
  sessionId: string;
  remoteHostId: string | null;
  deviceLinkDeviceId: string | null | undefined;
}) {
  const goal = useBoundGoal(sessionId);
  const local = !remoteHostId && deviceLinkDeviceId === null;
  const bound = Boolean(goal && goal.status === 'active');
  useEffect(() => {
    if (!local || !bound || autoOpened.has(sessionId)) return;
    autoOpened.add(sessionId);
    void (async () => {
      await ensureHydrated(sessionId);
      if (getBucket(sessionId).tabs.some((tab) => tab.kind === LEARNING_TODAY_TAB_KIND)) return;
      await addTab(sessionId, LEARNING_TODAY_TAB_KIND, {}, { activate: false });
    })().catch(() => {
      // A full tab bar or a closing session: the tab is a convenience, the conversation is unaffected.
    });
  }, [local, bound, sessionId]);
  return null;
}
