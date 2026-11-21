/**
 * conversation-marks —— 对话右侧的「标记」页签：主人在这场对话里标记的摘录。
 *
 * 不进「+」菜单：普通伙伴对话从顶栏右侧的标记入口打开，导师对话在「今天」旁自动加上。
 * 每个任务至多一个。正文与数据在 features/conversation-marks。
 */
import { lazy } from 'react';
import { Highlighter } from 'lucide-react';
import type { TFunction } from 'i18next';

import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useConversationMarks } from '@/features/conversation-marks/conversationMarksClient';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const ConversationMarksPanel = lazy(() =>
  import('@/features/conversation-marks/ConversationMarksPanel').then((module) => ({
    default: module.ConversationMarksPanel,
  })),
);

type ConversationMarksState = Record<never, never>;

/** The pill shows how many marks are still to be talked about. */
function ConversationMarksPillTitle({ t, sessionId }: { state: ConversationMarksState; t: TFunction; sessionId: string | null }) {
  const host = sessionId ? getStickySessionDeviceId(sessionId) : undefined;
  const { marks } = useConversationMarks(sessionId ? { sessionId, hostDeviceId: host ?? null } : null);
  const open = marks.filter((mark) => mark.state === 'open').length;
  return (
    <>
      {t('conversationMarks.title')}
      {open > 0 ? (
        <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--surface-chip)] px-1 text-10 font-medium tabular-nums leading-none text-[var(--text-primary)]">
          {open}
        </span>
      ) : null}
    </>
  );
}

function ConversationMarksPillIcon() {
  return <Highlighter size={13} />;
}

const plugin: TabKindPlugin<ConversationMarksState> = {
  kind: 'conversation-marks',
  menu: {
    kind: 'conversation-marks',
    labelKey: 'conversationMarks.title',
    icon: Highlighter,
    order: 20,
    enabled: true,
    hiddenFromMenu: true,
    singleton: true,
  },
  TabPillTitle: ConversationMarksPillTitle,
  TabPillIcon: ConversationMarksPillIcon,
  TabBody: ConversationMarksPanel,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
