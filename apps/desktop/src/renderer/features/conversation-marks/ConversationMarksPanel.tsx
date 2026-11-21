/**
 * The 标记 side panel: the owner's marks on this conversation, not-yet-discussed first, then the
 * discussed ones greyed below a divider; each group in conversation order. A row jumps back to
 * its message, the circle (personal todos' completion circle) toggles discussed, 就聊这点 quotes
 * the excerpt into the composer through 添加到对话's own path, delete is immediate with undo.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, CloudOff, Highlighter, MessageSquareQuote, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { appendQuoteToDraft } from '@/lib/composerDraftStore';
import { PriorityRing } from '@/features/bots/personalTodoVisuals';
import { requestChatTaskFocus } from '@/features/right-sidebar/plugins/background-tasks/chatTaskFocusIntent';
import { requestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { NARROW_WINDOW_MAX_WIDTH, requestRightSidebarFill } from '@/features/right-sidebar/lib/sidebarFillRequests';
import type { TabKindBodyProps } from '@/features/right-sidebar/types';
import type { ConversationMark, ConversationMarkScope, ConversationMarkSyncStatus } from '../../../shared/conversationMarks';
import {
  deleteConversationMark,
  groupConversationMarks,
  setConversationMarkDiscussed,
  useConversationMarks,
  useConversationMarkSyncStatus,
} from './conversationMarksClient';

/** 今天 → time; 昨天 → 昨天 time; earlier → month and day. */
export function formatMarkTime(at: number, now: number, language: string, yesterday: (time: string) => string): string {
  const date = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  if (at >= startOfToday) return time;
  if (at >= startOfToday - 24 * 60 * 60 * 1000) return yesterday(time);
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(date);
}

function useNarrowWindow(): boolean {
  const query = `(max-width: ${NARROW_WINDOW_MAX_WIDTH}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = () => setNarrow(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

/** Marks of a conversation on this computer (null) or on another one (its device id). */
export function marksScopeOf(sessionId: string, deviceLinkDeviceId: string | null | undefined): ConversationMarkScope | null {
  if (deviceLinkDeviceId === undefined) return null;
  return { sessionId, hostDeviceId: deviceLinkDeviceId };
}

function SyncLine({ status }: { status: ConversationMarkSyncStatus | null }) {
  const { t } = useTranslation();
  if (!status) return null;
  const text =
    status.phase === 'synced'
      ? t('conversationMarks.syncSynced')
      : status.phase === 'syncing'
        ? t('conversationMarks.syncSyncing')
        : status.pending > 0
          ? t('conversationMarks.syncOfflinePending', { count: status.pending })
          : t('conversationMarks.syncOffline');
  return <span className="shrink-0 whitespace-nowrap text-12 leading-[1.333] text-[var(--text-tertiary)]">{text}</span>;
}

function MarkRow({
  mark,
  scope,
  pending,
  onJump,
  onTalk,
}: {
  mark: ConversationMark;
  scope: ConversationMarkScope;
  pending: boolean;
  onJump: (mark: ConversationMark) => void;
  onTalk: (mark: ConversationMark) => void;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const discussed = mark.state === 'discussed';
  const who = mark.authorRole === 'user' ? t('conversationMarks.me') : mark.authorName ?? '';
  const time = formatMarkTime(mark.messageCreatedAt, Date.now(), i18n.language, (value) =>
    t('conversationMarks.yesterday', { time: value }),
  );
  const toggle = async () => {
    setBusy(true);
    try {
      await setConversationMarkDiscussed(scope, mark, !discussed);
    } finally {
      setBusy(false);
    }
  };
  const remove = (
    <Tip text={t('conversationMarks.delete')}>
      <button
        type="button"
        aria-label={t('conversationMarks.delete')}
        onClick={() => void deleteConversationMark(scope, mark)}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </Tip>
  );
  return (
    <li className="group flex items-start gap-2 rounded-lg p-2 hover:bg-[var(--surface-hover-soft)]">
      <button
        type="button"
        role="checkbox"
        aria-checked={discussed}
        aria-label={discussed ? t('conversationMarks.markOpen') : t('conversationMarks.markDiscussed')}
        aria-busy={busy}
        disabled={busy}
        onClick={() => void toggle()}
        className="-mx-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        {discussed ? (
          <span
            aria-hidden
            className={cn(
              'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)]',
              busy && 'opacity-50',
            )}
          >
            <Check size={12} />
          </span>
        ) : (
          <PriorityRing priority={0} className={busy ? 'opacity-50' : undefined} />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <button
          type="button"
          aria-label={t('conversationMarks.jumpToSource')}
          onClick={() => onJump(mark)}
          className="flex min-w-0 flex-col gap-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <span
            className={cn(
              'line-clamp-3 whitespace-pre-wrap break-words text-13 leading-[1.54]',
              discussed ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
            )}
          >
            {mark.quote}
          </span>
          <span className="flex items-center gap-1.5 text-12 leading-[1.333] text-[var(--text-tertiary)]">
            {who ? (
              <span className={discussed ? undefined : 'text-[var(--text-secondary)]'}>{who}</span>
            ) : null}
            <span>{time}</span>
            {pending ? (
              <CloudOff size={12} aria-label={t('conversationMarks.pending')} role="img" className="shrink-0" />
            ) : null}
          </span>
        </button>
        {discussed ? null : (
          <span className="flex items-center gap-1">
            <Button variant="secondary" size="xs" compact type="button" onClick={() => onTalk(mark)}>
              <MessageSquareQuote className="h-3 w-3" />
              {t('conversationMarks.talkAboutThis')}
            </Button>
            <span className="flex-1" />
            {remove}
          </span>
        )}
      </div>
      {discussed ? remove : null}
    </li>
  );
}

export function ConversationMarksPanel({ ctx, active, shellVisible }: TabKindBodyProps<Record<never, never>>) {
  const { t } = useTranslation();
  const scope = useMemo(
    () => marksScopeOf(ctx.sessionId, ctx.deviceLinkDeviceId),
    [ctx.sessionId, ctx.deviceLinkDeviceId],
  );
  const { loaded, marks } = useConversationMarks(scope);
  const status = useConversationMarkSyncStatus();
  const { open, discussed } = useMemo(() => groupConversationMarks(marks), [marks]);
  const pendingIds = useMemo(
    () => new Set(status?.phase === 'offline' ? status.pendingIds : []),
    [status],
  );
  const narrow = useNarrowWindow();
  const filling = useRef(false);
  const visible = (active ?? true) && (shellVisible ?? true);

  // Narrow window: the panel takes the whole window while it is in front.
  useEffect(() => {
    const shouldFill = narrow && visible;
    if (shouldFill === filling.current) return;
    filling.current = shouldFill;
    requestRightSidebarFill(shouldFill);
  }, [narrow, visible]);
  useEffect(
    () => () => {
      if (filling.current) requestRightSidebarFill(false);
    },
    [],
  );

  const backToConversation = () => {
    filling.current = false;
    requestRightSidebarFill(false);
    requestRightSidebarVisibility('close', { sessionId: ctx.sessionId, userInitiated: true });
  };
  const jump = (mark: ConversationMark) => {
    if (narrow) backToConversation();
    requestChatTaskFocus(ctx.sessionId, mark.messageClientId);
  };
  const talk = (mark: ConversationMark) => {
    if (narrow) backToConversation();
    appendQuoteToDraft(ctx.sessionId, { text: mark.quote });
  };

  if (!scope) return null;
  const firstLabel = open.length > 0 ? 'open' : discussed.length > 0 ? 'discussed' : null;
  const groupHeader = (label: 'open' | 'discussed', count: number) => (
    <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-3 text-12 leading-[1.333] text-[var(--text-tertiary)]">
      <span>
        {t(label === 'open' ? 'conversationMarks.groupOpen' : 'conversationMarks.groupDiscussed')}{' '}
        <span className="tabular-nums">{count}</span>
      </span>
      {firstLabel === label ? <SyncLine status={status} /> : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {narrow ? (
        <div className="flex shrink-0 items-center px-2 pt-2">
          <Button variant="secondary" tone="quiet" size="sm" compact type="button" onClick={backToConversation}>
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('conversationMarks.backToConversation')}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1">
        {loaded && marks.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-4 pt-24 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
              <Highlighter size={18} aria-hidden />
            </span>
            <span className="text-13 leading-[1.54] text-[var(--text-secondary)]">{t('conversationMarks.empty')}</span>
          </div>
        ) : null}
        {open.length > 0 ? (
          <>
            {groupHeader('open', open.length)}
            <ul>
              {open.map((mark) => (
                <MarkRow key={mark.id} mark={mark} scope={scope} pending={pendingIds.has(mark.id)} onJump={jump} onTalk={talk} />
              ))}
            </ul>
          </>
        ) : null}
        {discussed.length > 0 ? (
          <>
            {open.length > 0 ? <div className="mx-2 mt-2 border-t border-[var(--border-default)]" /> : null}
            {groupHeader('discussed', discussed.length)}
            <ul>
              {discussed.map((mark) => (
                <MarkRow key={mark.id} mark={mark} scope={scope} pending={pendingIds.has(mark.id)} onJump={jump} onTalk={talk} />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
