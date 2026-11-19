/**
 * The 标记 entry at the right of a teammate conversation's top bar: highlighter icon plus the
 * number of marks not yet talked about. Opens (or focuses) the marks tab in the right sidebar.
 */
import { Highlighter } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import type { ConversationMarkScope } from '../../../shared/conversationMarks';
import { useConversationMarks } from './conversationMarksClient';
import { openConversationMarksTab } from './openConversationMarksTab';

export function ConversationMarksEntryButton({ scope }: { scope: ConversationMarkScope }) {
  const { t } = useTranslation();
  const { marks } = useConversationMarks(scope);
  const open = marks.filter((mark) => mark.state === 'open').length;
  return (
    <Tip text={t('conversationMarks.title')}>
      <button
        type="button"
        onClick={() => void openConversationMarksTab(scope.sessionId)}
        aria-label={open > 0 ? t('conversationMarks.entryAria', { count: open }) : t('conversationMarks.title')}
        className="flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <Highlighter size={15} aria-hidden />
        {open > 0 ? <span className="tabular-nums">{open}</span> : null}
      </button>
    </Tip>
  );
}
