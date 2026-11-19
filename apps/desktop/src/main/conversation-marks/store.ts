import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONVERSATION_MARK_CHANGE_KEYS,
  CONVERSATION_MARK_CREATE_KEYS,
  CONVERSATION_MARK_QUOTE_MAX,
  type ConversationMark,
  type ConversationMarkCreate,
  type ConversationMarkScope,
  type ConversationMarkUpdate,
} from '../../shared/conversationMarks.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

/** Deleted marks stay as tombstones this long (undo, and replicas learning about the delete). */
export const MARK_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
/** Live marks per account. */
export const MARK_LIVE_LIMIT = 1500;
/**
 * The serialized file (tombstones included) a new mark may not push past: the shared-datasets
 * layer sends the whole set in one snapshot capped at 1.5 MB, so marks stay well inside it.
 */
export const MARK_STORE_MAX_BYTES = 1_200_000;

export interface StoredConversationMark extends ConversationMark {
  creationRequestId: string;
  updatedAt: number;
  /** Tombstone: the mark was deleted at this time; `restore` clears it. */
  deletedAt?: number;
}

interface MarkFile {
  version: 1;
  items: StoredConversationMark[];
}

export class MarkError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT' | 'BUSY' | 'CORRUPT_STORE') {
    super(code);
  }
}

const ID_TEXT = /^[^\s\u0000-\u001f]{1,200}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000;

function validCreate(input: Record<string, unknown>): ConversationMarkCreate {
  const allowed: readonly string[] = CONVERSATION_MARK_CREATE_KEYS;
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new MarkError('INVALID_INPUT');
  const {
    creationRequestId,
    sessionId,
    hostDeviceId,
    messageClientId,
    messageCreatedAt,
    authorRole,
    authorName,
    quote,
    start,
    end,
  } = input;
  if (typeof creationRequestId !== 'string' || !REQUEST_ID.test(creationRequestId)) throw new MarkError('INVALID_INPUT');
  if (typeof sessionId !== 'string' || !ID_TEXT.test(sessionId)) throw new MarkError('INVALID_INPUT');
  if (hostDeviceId !== undefined && (typeof hostDeviceId !== 'string' || !ID_TEXT.test(hostDeviceId)))
    throw new MarkError('INVALID_INPUT');
  if (typeof messageClientId !== 'string' || !ID_TEXT.test(messageClientId)) throw new MarkError('INVALID_INPUT');
  if (typeof messageCreatedAt !== 'number' || !Number.isFinite(messageCreatedAt) || messageCreatedAt < 0)
    throw new MarkError('INVALID_INPUT');
  if (authorRole !== 'user' && authorRole !== 'assistant') throw new MarkError('INVALID_INPUT');
  if (authorName !== undefined && (typeof authorName !== 'string' || authorName.length > 120))
    throw new MarkError('INVALID_INPUT');
  if (typeof quote !== 'string' || !quote.trim() || quote.length > CONVERSATION_MARK_QUOTE_MAX)
    throw new MarkError('INVALID_INPUT');
  if ((start === undefined) !== (end === undefined)) throw new MarkError('INVALID_INPUT');
  if (start !== undefined && (!isOffset(start) || !isOffset(end) || end <= start)) throw new MarkError('INVALID_INPUT');
  return {
    creationRequestId,
    sessionId,
    ...(hostDeviceId ? { hostDeviceId } : {}),
    messageClientId,
    messageCreatedAt,
    authorRole,
    ...(authorName ? { authorName } : {}),
    quote,
    ...(start !== undefined ? { start, end: end as number } : {}),
  };
}

/** The same mark, field for field (an idempotent creation retry). */
function sameCreation(item: StoredConversationMark, create: ConversationMarkCreate): boolean {
  return (
    item.sessionId === create.sessionId &&
    (item.hostDeviceId ?? null) === (create.hostDeviceId ?? null) &&
    item.messageClientId === create.messageClientId &&
    item.quote === create.quote &&
    (item.start ?? null) === (create.start ?? null) &&
    (item.end ?? null) === (create.end ?? null)
  );
}

function readable(raw: unknown): StoredConversationMark | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.startsWith('mark:')) return null;
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 1) return null;
  if (typeof raw.sessionId !== 'string' || typeof raw.messageClientId !== 'string') return null;
  if (typeof raw.quote !== 'string' || typeof raw.creationRequestId !== 'string') return null;
  if (raw.state !== 'open' && raw.state !== 'discussed') return null;
  return raw as unknown as StoredConversationMark;
}

/** Public projection: no request id, no tombstone bookkeeping. */
export function projectConversationMark(item: StoredConversationMark): ConversationMark {
  const { creationRequestId: _request, updatedAt: _updated, deletedAt: _deleted, ...mark } = item;
  return mark;
}

/**
 * A mark belongs to the conversation (computer, session). A conversation on this computer matches
 * marks stamped with any of this computer's ids, and marks written before it knew its id.
 */
export function markInScope(item: ConversationMark, scope: ConversationMarkScope, selfDeviceIds: readonly string[]): boolean {
  if (item.sessionId !== scope.sessionId) return false;
  if (scope.hostDeviceId) return item.hostDeviceId === scope.hostDeviceId;
  return !item.hostDeviceId || selfDeviceIds.includes(item.hostDeviceId);
}

/**
 * The account's conversation marks in one JSON file. Same guarantees as the personal todo file:
 * cross-process lock, atomic replace, per-item revision, owner check around every step.
 */
export function createConversationMarkStore(file: string, assertCurrent: () => void = () => {}, now = () => Date.now()) {
  async function read(): Promise<MarkFile> {
    assertCurrent();
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [] };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new MarkError('CORRUPT_STORE');
    }
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.items)) throw new MarkError('CORRUPT_STORE');
    // A single unreadable entry (written by a newer version, or damaged) is skipped, not fatal.
    const items = raw.items.map(readable).filter((item): item is StoredConversationMark => item !== null);
    assertCurrent();
    return { version: 1, items };
  }

  async function mutate<T>(fn: (state: MarkFile) => T): Promise<T> {
    assertCurrent();
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withCrossProcessLock(file + '.lock', { label: 'conversation-marks', waitMs: 12000 }, async (held) => {
      if (!held.held) throw new MarkError('BUSY');
      const state = await read();
      const result = fn(state);
      const cutoff = now() - MARK_TOMBSTONE_MS;
      state.items = state.items.filter((item) => !item.deletedAt || item.deletedAt > cutoff);
      assertCurrent();
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
        assertCurrent();
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      assertCurrent();
      return result;
    });
  }

  function apply(state: MarkFile, input: unknown): StoredConversationMark {
    if (!isRecord(input)) throw new MarkError('INVALID_INPUT');
    const at = now();
    if (input.id === undefined) {
      const create = validCreate(input);
      const existing = state.items.find((item) => item.creationRequestId === create.creationRequestId);
      if (existing) {
        if (!sameCreation(existing, create)) throw new MarkError('CONFLICT');
        return existing;
      }
      if (state.items.filter((item) => !item.deletedAt).length >= MARK_LIVE_LIMIT) throw new MarkError('LIMIT');
      if (Buffer.byteLength(JSON.stringify(state.items)) >= MARK_STORE_MAX_BYTES) throw new MarkError('LIMIT');
      const item: StoredConversationMark = {
        id: `mark:${randomUUID()}`,
        revision: 1,
        ...create,
        state: 'open',
        markedAt: at,
        updatedAt: at,
      };
      state.items.push(item);
      return item;
    }
    const allowed: readonly string[] = CONVERSATION_MARK_CHANGE_KEYS;
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new MarkError('INVALID_INPUT');
    const { id, expectedRevision, operation } = input;
    if (typeof id !== 'string' || typeof expectedRevision !== 'number') throw new MarkError('INVALID_INPUT');
    if (operation !== 'discuss' && operation !== 'reopen' && operation !== 'delete' && operation !== 'restore')
      throw new MarkError('INVALID_INPUT');
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) throw new MarkError('NOT_FOUND');
    if (item.revision !== expectedRevision) throw new MarkError('CONFLICT');
    if (operation === 'restore') {
      if (!item.deletedAt) return item;
      delete item.deletedAt;
    } else if (item.deletedAt) {
      throw new MarkError('NOT_FOUND');
    } else if (operation === 'delete') {
      item.deletedAt = at;
    } else {
      const next = operation === 'discuss' ? 'discussed' : 'open';
      if (item.state === next) return item;
      item.state = next;
    }
    item.revision += 1;
    item.updatedAt = at;
    return item;
  }

  return {
    /** Raw stored items including tombstones: the shared-datasets layer syncs them as they are. */
    async readAll(): Promise<StoredConversationMark[]> {
      return (await read()).items;
    },
    async list(scope: ConversationMarkScope, selfDeviceIds: readonly string[]): Promise<ConversationMark[]> {
      const { items } = await read();
      return items
        .filter((item) => !item.deletedAt && markInScope(item, scope, selfDeviceIds))
        .map(projectConversationMark);
    },
    /** Creation (no `id`) or a state change; throws MarkError on refusal. */
    async update(input: ConversationMarkUpdate | Record<string, unknown>): Promise<StoredConversationMark> {
      return mutate((state) => structuredClone(apply(state, input)));
    },
    /** Replica mirror: same-id items replaced by the home's, `remove` ids dropped. */
    async importItems(items: StoredConversationMark[], remove: string[]): Promise<void> {
      await mutate((state) => {
        const drop = new Set(remove);
        const incoming = new Map(items.map((item) => [item.id, item]));
        state.items = state.items.filter((item) => !drop.has(item.id) && !incoming.has(item.id));
        state.items.push(...items.map((item) => structuredClone(item)));
      });
    },
  };
}

export type ConversationMarkStore = ReturnType<typeof createConversationMarkStore>;
