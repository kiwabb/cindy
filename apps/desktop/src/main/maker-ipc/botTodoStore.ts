import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  applyTodoPatch,
  emptyTodoState,
  TodoError,
  normalizeTodoKey,
  todoVisible,
  validateTodoDeadline,
  validateTodoTimestamp,
  validTodoPriority,
  validTodoReminder,
  normalizeTodoTagIds,
  normalizeTodoSubtasks,
  type TodoPatch,
  type TodoState,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

function validText(value: unknown, max: number, required = false): boolean {
  return typeof value === 'string' && value.length <= max && (!required || !!value.trim());
}

function validTimestamp(value: unknown): boolean {
  try {
    validateTodoTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

export interface TodoIngestInput {
  source: string;
  sequence: number;
  patch?: TodoPatch;
  skip?: 'duplicate' | 'suppressed' | 'outside-scope' | 'no-action';
}
export interface TodoIngestResult {
  duplicate: boolean;
  suppressed?: boolean;
  todo?: TeammateTodo | null;
}
export interface BotTodoStore {
  read(): Promise<TodoState>;
  patch(patch: TodoPatch): Promise<TeammateTodo>;
  ingest(input: TodoIngestInput): Promise<TodoIngestResult>;
  prepareAction(
    id: string,
    revision: number,
    requestId: string,
  ): Promise<{ todo: TeammateTodo; dispatch: boolean }>;
  settleAction(
    id: string,
    requestId: string,
    result: { ok: boolean; uncertain?: boolean; error?: string },
  ): Promise<TeammateTodo | null>;
  /**
   * The companion moved to this computer (cloud-companions.md §2): its todos from the cloud
   * replace the items with the same id, `remove` ids are deleted. Per-computer plugin cursors
   * and receipts stay as they are.
   */
  importItems(items: TeammateTodo[], remove: string[]): Promise<void>;
  /**
   * Drops deleted-item tombstones whose key starts with `keyPrefix` and whose deletion
   * (updatedAt) is older than `olderThanMs` before `now`, together with the ingest receipts and
   * cursor of that key. A non-empty prefix is required so another producer's items are never
   * matched by accident. Returns how many items were removed; writes nothing when none qualify.
   */
  purgeDeleted(params: { olderThanMs: number; now: number; keyPrefix: string }): Promise<number>;
}
/** A separate versioned affair store preserves the old task/project file unchanged. */
export function createBotTodoStore(
  file: string,
  assertCurrent = () => {},
  ownerAuthored = () => true,
): BotTodoStore {
  async function read(): Promise<TodoState> {
    assertCurrent();
    let state: TodoState;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as TodoState;
      if (
        !raw ||
        typeof raw !== 'object' ||
        raw.version !== 1 ||
        !Array.isArray(raw.items) ||
        !raw.cursors ||
        !raw.receipts ||
        raw.items.some(
          (t) =>
            !t ||
            typeof t.id !== 'string' ||
            !Number.isInteger(t.revision) ||
            !Array.isArray(t.sources) ||
            !Array.isArray(t.history) ||
            !Array.isArray(t.associations) ||
            !['open', 'done'].includes(t.status),
        )
      )
        throw new TodoError('CORRUPT_STORE');
      if (
        typeof raw.cursors !== 'object' ||
        typeof raw.receipts !== 'object' ||
        Array.isArray(raw.cursors) ||
        Array.isArray(raw.receipts) ||
        Object.entries(raw.cursors).some(
          ([key, value]) => !key || !Number.isSafeInteger(value) || value < 0,
        ) ||
        Object.values(raw.receipts).some((value) => typeof value !== 'string')
      )
        throw new TodoError('CORRUPT_STORE');
      const ids = new Set<string>(),
        keys = new Set<string>();
      for (const t of raw.items) {
        if (ids.has(t.id) || keys.has(t.key)) throw new TodoError('CORRUPT_STORE');
        ids.add(t.id);
        keys.add(t.key);
        if (
          t.sources.some(
            (s) =>
              !s ||
              !validText(s.id, 512, true) ||
              !validText(s.label, 300, true) ||
              !['conversation', 'mail', 'feishu', 'github', 'community', 'task'].includes(s.kind) ||
              (s.ref !== undefined &&
                (!validText(s.ref, 2000) || !/^https:\/\/[^\s]+$/.test(s.ref))) ||
              (s.project !== undefined && !validText(s.project, 4096, true)) ||
              (s.version !== undefined && (!Number.isSafeInteger(s.version) || s.version < 0)) ||
              (s.observedAt !== undefined && !validTimestamp(s.observedAt)),
          ) ||
          t.associations.some(
            (a) =>
              !a ||
              !['task', 'pr'].includes(a.kind) ||
              !validText(a.id, 512, true) ||
              !validText(a.label, 300, true),
          ) ||
          t.history.some(
            (h) =>
              !h ||
              !validText(h.summary, 4000, true) ||
              !validTimestamp(h.at) ||
              (h.ref !== undefined && !validText(h.ref, 2000)),
          ) ||
          (t.next !== null &&
            (!t.next ||
              !validText(t.next.label, 100, true) ||
              !validText(t.next.instruction, 4000, true) ||
              !['advance', 'view', 'decide'].includes(t.next.kind))) ||
          (t.decision !== null &&
            (!t.decision ||
              !['deleted', 'muted', 'later'].includes(t.decision.kind) ||
              (t.decision.until !== undefined && !validTimestamp(t.decision.until)) ||
              (t.decision.kind === 'later' && !t.decision.until))) ||
          (t.action !== null &&
            (!t.action ||
              !validText(t.action.requestId, 80, true) ||
              !Number.isSafeInteger(t.action.revision) ||
              t.action.revision < 1 ||
              (t.action.error !== undefined && !validText(t.action.error, 1000)) ||
              !['received', 'accepted', 'failed', 'unknown'].includes(t.action.state)))
        )
          throw new TodoError('CORRUPT_STORE');
        if (
          typeof t.id !== 'string' ||
          !t.id ||
          t.id.length > 512 ||
          typeof t.key !== 'string' ||
          !t.key ||
          t.key.length > 512 ||
          !Number.isSafeInteger(t.revision) ||
          t.revision < 1 ||
          typeof t.title !== 'string' ||
          !t.title.trim() ||
          t.title.length > 300 ||
          typeof t.outcome !== 'string' ||
          !t.outcome.trim() ||
          t.outcome.length > 4000 ||
          typeof t.progress !== 'string' ||
          t.progress.length > 4000 ||
          typeof t.value !== 'string' ||
          t.value.length > 4000 ||
          !['assigned', 'discovered'].includes(t.origin) ||
          !validTimestamp(t.createdAt) ||
          !validTimestamp(t.updatedAt) ||
          (t.priority !== undefined && !validTodoPriority(t.priority)) ||
          (t.reminder !== undefined && !validTodoReminder(t.reminder))
        )
          throw new TodoError('CORRUPT_STORE');
        if (t.subtasks !== undefined) {
          try {
            const subtasks = normalizeTodoSubtasks(t.subtasks);
            if (subtasks.some((s, i) => s.title !== t.subtasks![i].title))
              throw new TodoError('CORRUPT_STORE');
          } catch {
            throw new TodoError('CORRUPT_STORE');
          }
        }
        if (t.tagIds !== undefined) {
          try {
            if (normalizeTodoTagIds(t.tagIds).length !== t.tagIds.length)
              throw new TodoError('CORRUPT_STORE');
          } catch {
            throw new TodoError('CORRUPT_STORE');
          }
        }
        try {
          validateTodoDeadline(t.sourceDeadline);
          if (t.suggestedDate !== null) {
            if (!validText(t.suggestedDate, 10)) throw new TodoError('CORRUPT_STORE');
            if (t.suggestedDate)
              validateTodoDeadline({ kind: 'date', date: t.suggestedDate, timeZone: 'UTC' });
          }
          if (t.deadlineOverride !== undefined) {
            if (
              !t.deadlineOverride ||
              typeof t.deadlineOverride !== 'object' ||
              Array.isArray(t.deadlineOverride)
            )
              throw new TodoError('CORRUPT_STORE');
            validateTodoDeadline(t.deadlineOverride.value);
          }
          if (t.deadlineCandidate !== null) {
            if (
              !t.deadlineCandidate ||
              typeof t.deadlineCandidate !== 'object' ||
              Array.isArray(t.deadlineCandidate)
            )
              throw new TodoError('CORRUPT_STORE');
            validateTodoDeadline(t.deadlineCandidate.value);
            if (
              typeof t.deadlineCandidate.reason !== 'string' ||
              !t.deadlineCandidate.reason.trim() ||
              t.deadlineCandidate.reason.length > 2000
            )
              throw new TodoError('CORRUPT_STORE');
          }
        } catch {
          throw new TodoError('CORRUPT_STORE');
        }
      }
      state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = emptyTodoState();
    }
    assertCurrent();
    return state;
  }
  async function mutate<T>(fn: (state: TodoState) => T): Promise<T> {
    assertCurrent();
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withCrossProcessLock(
      file + '.lock',
      { label: 'teammate-todo', waitMs: 12000 },
      async (held) => {
        if (!held.held) throw new TodoError('BUSY');
        assertCurrent();
        const state = await read(),
          result = fn(state);
        assertCurrent();
        const temp = file + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(temp, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
          assertCurrent();
          await fs.rename(temp, file);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        assertCurrent();
        return result;
      },
    );
  }
  // Classify inside the locked mutation. Automatic discovery cannot manufacture an
  // owner assignment or reclassify existing records, including legacy records.
  const attributedPatch = (state: TodoState, patch: TodoPatch): TodoPatch => {
    if (ownerAuthored()) return patch;
    const key = patch.key === undefined ? undefined : normalizeTodoKey(patch.key);
    const existing = state.items.find(item => patch.id ? item.id === patch.id : item.key === key);
    return { ...patch, origin: existing?.origin ?? 'discovered' };
  };
  return {
    read,
    patch: (patch: TodoPatch) => mutate((s) => applyTodoPatch(s, attributedPatch(s, patch), 'todo:' + randomUUID())),
    importItems: (items: TeammateTodo[], remove: string[]) =>
      mutate((s) => {
        const replaced = new Set([...items.map((item) => item.id), ...remove]);
        const kept = s.items.filter((item) => !replaced.has(item.id));
        // Keys are unique in the store: a different todo (another companion merged in) with a key
        // already taken gets a stable key of its own, the same on every rerun.
        const keys = new Set(kept.map((item) => item.key));
        const added = structuredClone(items).map((item) => {
          let key = item.key;
          for (let attempt = 0; keys.has(key); attempt += 1) {
            const tag = createHash('sha256').update(item.id + (attempt ? '#' + attempt : '')).digest('hex').slice(0, 10);
            key = item.key.slice(0, 500) + '~' + tag;
          }
          keys.add(key);
          return key === item.key ? item : { ...item, key };
        });
        s.items = [...kept, ...added];
      }),
    purgeDeleted: async ({ olderThanMs, now, keyPrefix }) => {
      if (!keyPrefix || !Number.isFinite(olderThanMs) || !Number.isFinite(now))
        throw new TodoError('INVALID_INPUT');
      const cutoff = now - olderThanMs;
      const expired = (t: TeammateTodo) =>
        t.decision?.kind === 'deleted' &&
        t.key.startsWith(keyPrefix) &&
        Date.parse(t.updatedAt) < cutoff;
      // Cheap unlocked check so the daily sweep does not rewrite the file when nothing expired.
      if (!(await read()).items.some(expired)) return 0;
      return mutate((s) => {
        const gone = new Set(s.items.filter(expired).map((t) => t.key));
        s.items = s.items.filter((t) => !gone.has(t.key));
        for (const key of gone) delete s.cursors[key];
        for (const receipt of Object.keys(s.receipts))
          if (gone.has(receipt.slice(0, receipt.lastIndexOf(':')))) delete s.receipts[receipt];
        return gone.size;
      });
    },
    ingest: (params: {
      source: string;
      sequence: number;
      patch?: TodoPatch;
      skip?: 'duplicate' | 'suppressed' | 'outside-scope' | 'no-action';
    }) =>
      mutate((s) => {
        if (
          !/^[A-Za-z0-9:_./-]{1,512}$/.test(params.source) ||
          ['__proto__', 'prototype', 'constructor'].includes(params.source) ||
          !Number.isSafeInteger(params.sequence) ||
          params.sequence < 0
        )
          throw new TodoError('INVALID_EVENT');
        const receipt = params.source + ':' + params.sequence;
        if (
          params.sequence <=
            (Object.hasOwn(s.cursors, params.source) ? s.cursors[params.source] : -1) ||
          Object.hasOwn(s.receipts, receipt)
        )
          return { duplicate: true };
        if (!params.patch && !params.skip) throw new TodoError('INVALID_EVENT');
        const key =
          params.patch?.key === undefined ? undefined : normalizeTodoKey(params.patch.key);
        const existing = s.items.find((t) => t.key === key || t.id === params.patch?.id);
        const suppressed = (!!existing && !todoVisible(existing)) || existing?.status === 'done';
        const saved =
          params.patch && !suppressed
            ? applyTodoPatch(s, attributedPatch(s, params.patch), 'todo:' + randomUUID())
            : null;
        s.cursors[params.source] = params.sequence;
        // The monotonic cursor already proves older receipts; retain only the latest per stream.
        for (const key of Object.keys(s.receipts)) {
          const split = key.lastIndexOf(':');
          if (key.slice(0, split) === params.source) delete s.receipts[key];
        }
        s.receipts[receipt] = saved?.id ?? params.skip ?? 'suppressed';
        return { duplicate: false, suppressed, todo: saved };
      }),
    prepareAction: (id: string, revision: number, requestId: string) =>
      mutate((s) => {
        const t = s.items.find((t) => t.id === id);
        if (!t) throw new TodoError('NOT_FOUND');
        if (t.action && (t.action.requestId === requestId || t.action.state !== 'failed'))
          return { todo: t, dispatch: false };
        if (t.revision !== revision) throw new TodoError('CONFLICT');
        if (t.decision?.kind === 'later' && todoVisible(t)) t.decision = null;
        if (t.status !== 'open' || t.decision || !t.next || t.next.kind === 'view')
          throw new TodoError('NO_NEXT_ACTION');
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new TodoError('INVALID_REQUEST_ID');
        t.action = { requestId, revision: t.revision, state: 'received' };
        return { todo: structuredClone(t), dispatch: true };
      }),
    settleAction: (
      id: string,
      requestId: string,
      result: { ok: boolean; uncertain?: boolean; error?: string },
    ) =>
      mutate((s) => {
        const t = s.items.find((t) => t.id === id);
        if (!t?.action || t.action.requestId !== requestId || t.action.state !== 'received')
          return null;
        t.action = {
          ...t.action,
          state: result.ok ? 'accepted' : result.uncertain ? 'unknown' : 'failed',
          ...(result.error ? { error: result.error.slice(0, 500) } : {}),
        };
        return t;
      }),
  };
}
