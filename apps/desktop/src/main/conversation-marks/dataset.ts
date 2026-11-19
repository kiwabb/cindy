import { createHash, randomUUID } from 'node:crypto';
import type { ConversationMarkUpdate } from '../../shared/conversationMarks.js';
import type { SharedDatasetDefinition, SharedUpdate } from '../shared-datasets/api.js';
import { MarkError, type ConversationMarkStore, type StoredConversationMark } from './store.js';

export const CONVERSATION_MARKS_DATASET_ID = 'conversation-marks';
/** Bump when a peer on the previous version could not read, or would corrupt, the stored marks. */
export const CONVERSATION_MARKS_SCHEMA_VERSION = 1;

/** Private marker on a carried-over creation: the carried mark was already discussed. */
const CARRY_DISCUSSED = 'carryDiscussed';

export interface ConversationMarksDatasetPorts {
  open(): { store: ConversationMarkStore; assertCurrent(): void };
  selfDeviceId(): string | null;
  onLocalChange(callback: () => void): () => void;
}

/**
 * Conversation marks as a shared dataset: items are the raw stored marks (tombstones included),
 * the authoritative write is the store's own `update`. No device-local fields: the conversation a
 * mark points at is named by (computer id, session id, message clientId), which every computer sees
 * the same; a mark made before this computer knew its own id is stamped when it is carried over.
 */
export function createConversationMarksDataset(
  ports: ConversationMarksDatasetPorts,
): SharedDatasetDefinition<StoredConversationMark, undefined> {
  return {
    id: CONVERSATION_MARKS_DATASET_ID,
    schemaVersion: CONVERSATION_MARKS_SCHEMA_VERSION,
    async readItems() {
      const { store, assertCurrent } = ports.open();
      const items = await store.readAll();
      assertCurrent();
      return items;
    },
    cursorOf(items) {
      return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 32);
    },
    async replaceMirror(items, removeIds) {
      const { store, assertCurrent } = ports.open();
      await store.importItems(items, removeIds);
      assertCurrent();
    },
    async applySubmit(update: SharedUpdate) {
      const { [CARRY_DISCUSSED]: carryDiscussed, ...plain } = update;
      const { store, assertCurrent } = ports.open();
      let mark = await store.update(plain as unknown as ConversationMarkUpdate);
      if (carryDiscussed === true && mark.state !== 'discussed') {
        mark = await store.update({ id: mark.id, expectedRevision: mark.revision, operation: 'discuss' });
      }
      assertCurrent();
      return mark;
    },
    onLocalChange: (callback) => ports.onLocalChange(callback),
    errorCode: (error) => (error instanceof MarkError ? error.code : null),
    creationUpdate(item, requestId) {
      if (item.deletedAt) return null;
      const hostDeviceId = item.hostDeviceId ?? ports.selfDeviceId() ?? undefined;
      return {
        creationRequestId: requestId,
        sessionId: item.sessionId,
        ...(hostDeviceId ? { hostDeviceId } : {}),
        messageClientId: item.messageClientId,
        messageCreatedAt: item.messageCreatedAt,
        authorRole: item.authorRole,
        ...(item.authorName ? { authorName: item.authorName } : {}),
        quote: item.quote,
        ...(item.start !== undefined && item.end !== undefined ? { start: item.start, end: item.end } : {}),
        ...(item.state === 'discussed' ? { [CARRY_DISCUSSED]: true } : {}),
      };
    },
    renewCreation: (update) => ({ ...update, creationRequestId: `retry-${randomUUID()}` }),
    reviseUpdate(local, remote) {
      if (remote.deletedAt) return null;
      if (local.deletedAt) return { operation: 'delete' };
      if (local.state !== remote.state) return { operation: local.state === 'discussed' ? 'discuss' : 'reopen' };
      return null;
    },
  };
}
