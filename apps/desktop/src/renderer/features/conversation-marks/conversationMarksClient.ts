/**
 * Renderer side of conversation marks: one cached list per conversation, refreshed on the main
 * process's change push, plus the actions the selection pill, the highlights and the side panel
 * share. Marks are the owner's own; nothing here reaches the model.
 */
import { useCallback, useSyncExternalStore } from 'react';
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
  /** Needs a read when next watched: never read yet, or nobody watched it for a while. */
  stale: boolean;
  inFlight: boolean;
}

const entries = new Map<string, Entry>();
let status: ConversationMarkSyncStatus | null = null;
let statusStale = true;
let statusInFlight = false;
let statusGeneration = 0;
const statusListeners = new Set<() => void>();
let unsubscribePush: (() => void) | null = null;

function api() {
  return window.electronAPI?.localDb?.conversationMarks;
}

/** Every read returns new objects; equal content keeps the old one so nothing re-renders. */
const sameContent = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function refresh(entry: Entry): Promise<void> {
  const generation = ++entry.generation;
  entry.stale = false;
  entry.inFlight = true;
  let marks: ConversationMark[];
  try {
    marks = (await api()?.list(entry.scope)) ?? [];
  } catch {
    marks = entry.snapshot.marks;
  }
  if (generation !== entry.generation) return;
  entry.inFlight = false;
  if (entry.snapshot.loaded && sameContent(entry.snapshot.marks, marks)) return;
  entry.snapshot = { loaded: true, marks };
  for (const listener of entry.listeners) listener();
}

async function refreshStatus(): Promise<void> {
  const generation = ++statusGeneration;
  statusStale = false;
  statusInFlight = true;
  let next: ConversationMarkSyncStatus | null;
  try {
    next = (await api()?.syncStatus()) ?? null;
  } catch {
    next = null;
  }
  // A late answer to an older read must not overwrite a newer one.
  if (generation !== statusGeneration) return;
  statusInFlight = false;
  if (sameContent(status, next)) return;
  status = next;
  for (const listener of statusListeners) listener();
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  ensurePush();
  if (statusStale && !statusInFlight) void refreshStatus();
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size === 0) statusStale = true;
  };
}

const readStatus = () => status;

function ensurePush(): void {
  if (unsubscribePush || !api()) return;
  unsubscribePush = api()!.onChanged(() => {
    // Unwatched lists read again when next watched (a read with nobody watching, such as an
    // undo after leaving the conversation, may have cleared the flag).
    for (const entry of entries.values()) {
      if (entry.listeners.size > 0) void refresh(entry);
      else entry.stale = true;
    }
    if (statusListeners.size > 0) void refreshStatus();
    else statusStale = true;
  });
}

function entryFor(scope: ConversationMarkScope): Entry {
  const key = scopeKey(scope);
  let entry = entries.get(key);
  if (!entry) {
    entry = { scope, snapshot: EMPTY, listeners: new Set(), generation: 0, stale: true, inFlight: false };
    entries.set(key, entry);
  }
  return entry;
}

/** Marks of one conversation (local, or `hostDeviceId` for a conversation on another computer). */
export function useConversationMarks(scope: ConversationMarkScope | null): ConversationMarksSnapshot {
  // Call sites build `scope` inline; the subscription follows the conversation it names, so a
  // re-render does not unsubscribe and subscribe again.
  const sessionId = scope?.sessionId;
  const hostDeviceId = scope?.hostDeviceId ?? null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (sessionId === undefined) return () => {};
      const entry = entryFor({ sessionId, hostDeviceId });
      entry.listeners.add(listener);
      ensurePush();
      if (entry.stale && !entry.inFlight) void refresh(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) entry.stale = true;
      };
    },
    [sessionId, hostDeviceId],
  );
  const getSnapshot = useCallback(
    () => (sessionId === undefined ? EMPTY : entryFor({ sessionId, hostDeviceId }).snapshot),
    [sessionId, hostDeviceId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** One status line for the list header; null while sync is off. */
export function useConversationMarkSyncStatus(): ConversationMarkSyncStatus | null {
  return useSyncExternalStore(subscribeStatus, readStatus);
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
