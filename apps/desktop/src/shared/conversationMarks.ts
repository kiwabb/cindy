/**
 * Conversation marks: excerpts of chat messages the owner highlights to come back to later.
 *
 * A mark belongs to one conversation, named by the computer the conversation lives on plus its
 * session id, and points at one message by its `clientId` (the same raw ids every computer sees
 * when it opens that conversation, locally or remotely). Marks are the owner's own notes: they are
 * never sent to the model and teammates have no tool for them.
 */

/** Stored excerpt cap: a mark is a pointer back into the conversation, not a copy of it. */
export const CONVERSATION_MARK_QUOTE_MAX = 600;

export type ConversationMarkState = 'open' | 'discussed';
export type ConversationMarkAuthorRole = 'user' | 'assistant';

/** What the renderer sees (no internal request ids, no tombstones). */
export interface ConversationMark {
  id: string;
  revision: number;
  sessionId: string;
  /** Computer the conversation lives on; absent only for marks written before it was known. */
  hostDeviceId?: string;
  messageClientId: string;
  /** Message time (ms); orders the list and is the time shown on each row. */
  messageCreatedAt: number;
  authorRole: ConversationMarkAuthorRole;
  /** Teammate name at marking time; the owner's own messages carry none. */
  authorName?: string;
  quote: string;
  /** Character offsets of the excerpt inside the message's rendered text (the anchor). */
  start?: number;
  end?: number;
  state: ConversationMarkState;
  markedAt: number;
}

export type ConversationMarkOperation = 'discuss' | 'reopen' | 'delete' | 'restore';

export interface ConversationMarkCreate {
  creationRequestId: string;
  sessionId: string;
  hostDeviceId?: string;
  messageClientId: string;
  messageCreatedAt: number;
  authorRole: ConversationMarkAuthorRole;
  authorName?: string;
  quote: string;
  start?: number;
  end?: number;
}

export interface ConversationMarkChange {
  id: string;
  expectedRevision: number;
  operation: ConversationMarkOperation;
}

export type ConversationMarkUpdate = ConversationMarkCreate | ConversationMarkChange;

export const CONVERSATION_MARK_CREATE_KEYS = [
  'creationRequestId',
  'sessionId',
  'hostDeviceId',
  'messageClientId',
  'messageCreatedAt',
  'authorRole',
  'authorName',
  'quote',
  'start',
  'end',
] as const;

export const CONVERSATION_MARK_CHANGE_KEYS = ['id', 'expectedRevision', 'operation'] as const;

/** One line of status above the list; absent when sync is off. */
export interface ConversationMarkSyncStatus {
  /** `synced`, `syncing` (a flush in flight while the main computer is reachable), `offline`. */
  phase: 'synced' | 'syncing' | 'offline';
  pending: number;
  /** Mark ids with an edit made here that the main computer has not accepted yet. */
  pendingIds: string[];
}

export interface ConversationMarkScope {
  sessionId: string;
  /** Remote conversation: the computer it lives on. Local conversations leave it out. */
  hostDeviceId?: string | null;
}
