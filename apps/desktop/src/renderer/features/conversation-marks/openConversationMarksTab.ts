import { addOrFocusSingletonTab, addTab, ensureHydrated, getBucket } from '@/features/right-sidebar/store';
import { requestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';

export const CONVERSATION_MARKS_TAB_KIND = 'conversation-marks' as const;

/** Opens (or focuses) the marks tab beside this conversation and shows the right sidebar. */
export async function openConversationMarksTab(sessionId: string): Promise<void> {
  // The optimistic add assumes a hydrated bucket (same race note as openBackgroundTasksTab).
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, CONVERSATION_MARKS_TAB_KIND, {});
  requestRightSidebarVisibility('open', { sessionId, userInitiated: true });
}

/** Adds the marks tab without focusing it or opening the sidebar (beside a tutor's Today tab). */
export async function addConversationMarksTabQuietly(sessionId: string): Promise<void> {
  await ensureHydrated(sessionId);
  if (getBucket(sessionId).tabs.some((tab) => tab.kind === CONVERSATION_MARKS_TAB_KIND)) return;
  await addTab(sessionId, CONVERSATION_MARKS_TAB_KIND, {}, { activate: false });
}

/** Whether this conversation's sidebar currently shows the marks tab in front. */
export function isConversationMarksTabActive(sessionId: string): boolean {
  const bucket = getBucket(sessionId);
  const active = bucket.tabs.find((tab) => tab.id === bucket.activeTabId);
  return active?.kind === CONVERSATION_MARKS_TAB_KIND;
}
