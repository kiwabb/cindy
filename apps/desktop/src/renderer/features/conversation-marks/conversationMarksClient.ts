/**
 * Renderer side of conversation marks: one cached list per conversation, refreshed on the main
 * process's change push, plus the actions the selection pill, the highlights and the side panel
 * share. Marks are the owner's own; nothing here reaches the model.
 */
import { useSyncExternalStore } from 'react';
import { t } from 'i18next';
import { toast } from '@/lib/toast';
import {
  CONVERSATION_MARK_QUOTE_MAX,
  type ConversationMark,
  type ConversationMarkAuthorRole,
  type ConversationMarkScope,
  type ConversationMarkSyncStatus,
} from '../../../shared/conversationMarks';

export interface ConversationMarksSnapshot {
  loaded: boolean;
  marks: ConversationMark[];
}

const EMPTY: ConversationMarksSnapshot = { loaded: false, marks: [] };
const scopeKey = (scope: ConversationMarkScope) => `${scope.hostDeviceId ?? ''}\u0000${scope.sessionId}`;

interface Entry {
  scope: ConversationMarkScope;
  snapshot: ConversationMarksSnapshot;
  listeners: Set<() => void>;
  generation: number;
}

const entries = new Map<string, Entry>();
let status: ConversationMarkSyncStatus | null = null;
const statusListeners = new Set<() => void>();
let unsubscribePush: (() => void) | null = null;

function api() {
  return window.electronAPI?.localDb?.conversationMarks;
}

async function refresh(entry: Entry): Promise<void> {
  const generation = ++entry.generation;
  try {
    const marks = (await api()?.list(entry.scope)) ?? [];
    if (generation !== entry.generation) return;
    entry.snapshot = { loaded: true, marks };
  } catch {
    if (generation !== entry.generation) return;
    entry.snapshot = { loaded: true, marks: entry.snapshot.marks };
  }
  for (const listener of entry.listeners) listener();
}

async function refreshStatus(): Promise<void> {
  try {
    status = (await api()?.syncStatus()) ?? null;
  } catch {
    status = null;
  }
  for (const listener of statusListeners) listener();
}

function ensurePush(): void {
  if (unsubscribePush || !api()) return;
  unsubscribePush = api()!.onChanged(() => {
    for (const entry of entries.values()) if (entry.listeners.size > 0) void refresh(entry);
    if (statusListeners.size > 0) void refreshStatus();
  });
}

function entryFor(scope: ConversationMarkScope): Entry {
  const key = scopeKey(scope);
  let entry = entries.get(key);
  if (!entry) {
    entry = { scope, snapshot: EMPTY, listeners: new Set(), generation: 0 };
    entries.set(key, entry);
  }
  return entry;
}

/** Marks of one conversation (local, or `hostDeviceId` for a conversation on another computer). */
export function useConversationMarks(scope: ConversationMarkScope | null): ConversationMarksSnapshot {
  const key = scope ? scopeKey(scope) : null;
  const snapshot = useSyncExternalStore(
    (listener) => {
      if (!scope) return () => {};
      const entry = entryFor(scope);
      entry.listeners.add(listener);
      ensurePush();
      if (entry.listeners.size === 1) void refresh(entry);
      return () => entry.listeners.delete(listener);
    },
    () => (key && scope ? entryFor(scope).snapshot : EMPTY),
  );
  return snapshot;
}

/** One status line for the list header; null while sync is off. */
export function useConversationMarkSyncStatus(): ConversationMarkSyncStatus | null {
  const value = useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      ensurePush();
      if (statusListeners.size === 1) void refreshStatus();
      return () => statusListeners.delete(listener);
    },
    () => status,
  );
  return value;
}

function refreshScope(scope: ConversationMarkScope): void {
  const entry = entries.get(scopeKey(scope));
  if (entry) void refresh(entry);
}

/** Unread first, discussed last; each group in conversation order (message time, then position). */
export function groupConversationMarks(marks: readonly ConversationMark[]) {
  const ordered = [...marks].sort(
    (a, b) => a.messageCreatedAt - b.messageCreatedAt || (a.start ?? 0) - (b.start ?? 0) || a.markedAt - b.markedAt,
  );
  return {
    open: ordered.filter((mark) => mark.state === 'open'),
    discussed: ordered.filter((mark) => mark.state === 'discussed'),
  };
}

export interface MarkSelectionInput {
  text: string;
  messageClientId: string;
  start?: number;
  end?: number;
}

export interface MarkMessageFacts {
  authorRole: ConversationMarkAuthorRole;
  messageCreatedAt: number;
  authorName?: string;
}

function newRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function failed(): void {
  toast.error(t('conversationMarks.saveFailed'));
}

export async function createConversationMark(
  scope: ConversationMarkScope,
  selection: MarkSelectionInput,
  facts: MarkMessageFacts,
): Promise<void> {
  const quote = selection.text.trim();
  if (!quote) return;
  const clipped = quote.length > CONVERSATION_MARK_QUOTE_MAX;
  try {
    await api()!.update({
      creationRequestId: newRequestId(),
      sessionId: scope.sessionId,
      ...(scope.hostDeviceId ? { hostDeviceId: scope.hostDeviceId } : {}),
      messageClientId: selection.messageClientId,
      messageCreatedAt: facts.messageCreatedAt,
      authorRole: facts.authorRole,
      ...(facts.authorName ? { authorName: facts.authorName.slice(0, 120) } : {}),
      quote: clipped ? `${quote.slice(0, CONVERSATION_MARK_QUOTE_MAX - 1)}…` : quote,
      // A clipped excerpt no longer matches its offsets; highlight it by its start instead.
      ...(selection.start !== undefined && selection.end !== undefined && !clipped
        ? { start: selection.start, end: selection.end }
        : {}),
    });
  } catch {
    failed();
  }
  refreshScope(scope);
}

export async function setConversationMarkDiscussed(
  scope: ConversationMarkScope,
  mark: ConversationMark,
  discussed: boolean,
): Promise<void> {
  try {
    await api()!.update({ id: mark.id, expectedRevision: mark.revision, operation: discussed ? 'discuss' : 'reopen' });
  } catch {
    failed();
  }
  refreshScope(scope);
}

/** Deletes at once (no confirmation) and offers undo in the toast. */
export async function deleteConversationMark(scope: ConversationMarkScope, mark: ConversationMark): Promise<void> {
  let deleted: ConversationMark;
  try {
    deleted = await api()!.update({ id: mark.id, expectedRevision: mark.revision, operation: 'delete' });
  } catch {
    failed();
    refreshScope(scope);
    return;
  }
  refreshScope(scope);
  toast.success(t('conversationMarks.deleted'), {
    duration: 6000,
    action: {
      label: t('conversationMarks.undo'),
      onClick: () => {
        void api()!
          .update({ id: deleted.id, expectedRevision: deleted.revision, operation: 'restore' })
          .catch(failed)
          .finally(() => refreshScope(scope));
      },
    },
  });
}
