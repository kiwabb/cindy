import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  SHARED_DATASETS_MAX_SNAPSHOT_BYTES,
  SHARED_DATASETS_VERSION,
  parseSharedDatasetsCaps,
  parseSharedDatasetsChangedPush,
  parseSharedDatasetsRequest,
  parseSharedDatasetsSnapshotReply,
  parseSharedDatasetsSubmitReply,
  type SharedDatasetCapsEntry,
  type SharedDatasetRole,
  type SharedDatasetsRequest,
  type SharedDatasetsSnapshotReply,
  type SharedDatasetsSubmitReply,
} from '@cindy/device-link';
import { createKeyedMutex } from './keyedMutex.js';
import {
  createDatasetFiles,
  type DatasetFiles,
  type DatasetState,
  type Outbox,
  type OutboxOp,
} from './storage.js';
import {
  SharedDatasetError,
  type AnySharedDatasetDefinition,
  type ConflictChoice,
  type SharedDatasetConflict,
  type SharedDatasetRegistry,
  type SharedDatasetSyncStatus,
  type SharedDatasetsPorts,
  type SharedItem,
  type SharedOwnerScope,
  type SharedPeerFact,
  type SharedResult,
  type SharedUpdate,
} from './types.js';

/** Coalesces bursts of triggers (push + outbox + presence) into one sync. */
const TRIGGER_DEBOUNCE_MS = 250;
/** Safety net when no push arrives; the push is the normal trigger. */
export const SYNC_FALLBACK_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = SYNC_FALLBACK_MS;
export const PUSH_DEBOUNCE_MS = 500;
/** Presence flaps must not turn into a caps storm. */
const DISCOVERY_MIN_INTERVAL_MS = 15_000;
const CAPS_CONCURRENCY = 4;
const MAX_REBASES_PER_CYCLE = 3;

export class SharedDatasetPeerError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

interface Candidate {
  deviceId: string;
  epoch: number;
  /** The computer itself said it is home (vs. a replica reporting who its home is). */
  confirmed: boolean;
}

interface Ctx {
  id: string;
  def: AnySharedDatasetDefinition;
  scope: SharedOwnerScope;
  files: DatasetFiles;
  key: string;
  /** The definition touches the store of whichever account is active when it is called. */
  guard<T>(call: () => T): T;
}

type SyncOutcome = 'synced' | 'inactive' | 'not-home';

interface Scheduler {
  cancel?: () => void;
  failures: number;
  running: boolean;
  /** A trigger arrived during the run; 'force' (push, presence) may shorten a backoff, 'normal' (local edit) may not. */
  rerun: false | 'normal' | 'force';
  lastError?: string;
}

/** Higher epoch wins; equal epochs resolve to the lexicographically smaller device id. */
function beats(a: { epoch: number; deviceId: string }, b: { epoch: number; deviceId: string }) {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.deviceId < b.deviceId);
}

/** The op's identity (when the sender names it) is part of what a receipt answers for. */
function hashUpdate(update: SharedUpdate, opId?: string): string {
  return createHash('sha256').update(JSON.stringify(opId ? [opId, update] : update)).digest('hex').slice(0, 32);
}

function importRequestId(selfDeviceId: string, itemId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '-');
  const plain = `import-${safe(selfDeviceId)}-${safe(itemId.replace(/^[^:]*:/, ''))}`;
  if (plain.length <= 80) return plain;
  return `import-${createHash('sha256').update(`${selfDeviceId}|${itemId}`).digest('hex').slice(0, 32)}`;
}

function isItem(value: unknown): value is SharedItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SharedItem).id === 'string' &&
    Number.isInteger((value as SharedItem).revision)
  );
}

function errorCodeOf(error: unknown): string {
  if (error instanceof SharedDatasetPeerError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'SYNC_FAILED';
}

export function createSharedDatasetsEngine(
  ports: SharedDatasetsPorts,
  registry: SharedDatasetRegistry,
) {
  /** One whole sync / role change at a time per dataset; holds across network waits. */
  const syncMutex = createKeyedMutex();
  /** Short critical sections over the files and the mirror; never held across the network. */
  const fileMutex = createKeyedMutex();
  const schedulers = new Map<string, Scheduler>();
  const pushTimers = new Map<string, () => void>();
  const roles = new Map<string, SharedDatasetRole>();
  const lastDiscovery = new Map<string, number>();
  const peerSeen = new Map<string, number>();
  const unsubscribeLocal = new Map<string, () => void>();
  /** Per dataset: the computers that follow this one as home (from caps and from their requests). */
  const replicaPeers = new Map<string, Set<string>>();
  /** Datasets of this process whose home role already looked for a better home since start. */
  const resumed = new Set<string>();
  const noteReplica = (key: string, deviceId: string, follows: boolean) => {
    let set = replicaPeers.get(key);
    if (!set) replicaPeers.set(key, (set = new Set()));
    if (follows) set.add(deviceId);
    else set.delete(deviceId);
  };
  const changedListeners = new Set<(datasetId: string) => void>();
  /** Status-only changes (presence, sync outcome) as well as every data change. */
  const statusListeners = new Set<(datasetId: string) => void>();
  /** Writers waiting for their own op to reach the home (opId -> settle). */
  const flushWaiters = new Map<string, (settled: SharedResult | null) => void>();

  function emitStatus(id: string) {
    for (const listener of statusListeners) {
      try {
        listener(id);
      } catch {
        // One subscriber must not block the others.
      }
    }
  }

  function emitChanged(id: string) {
    emitStatus(id);
    for (const listener of changedListeners) {
      try {
        listener(id);
      } catch {
        // One subscriber must not block the others or the sync.
      }
    }
  }

  function open(id: string): Ctx {
    const def = registry.get(id);
    if (!def) throw new SharedDatasetError('UNKNOWN_DATASET', id);
    const scope = ports.captureScope();
    scope.assertCurrent();
    return {
      id,
      def,
      scope,
      files: createDatasetFiles(path.join(scope.baseDir, id), scope.assertCurrent),
      key: `${scope.owner}\u0000${id}`,
      guard: (call) => {
        scope.assertCurrent();
        return call();
      },
    };
  }

  async function saveState(ctx: Ctx, state: DatasetState) {
    await ctx.files.writeState(state);
    roles.set(ctx.key, state.role);
  }

  const errorCode = (def: AnySharedDatasetDefinition, error: unknown): string | null =>
    def.errorCode?.(error) ?? (error instanceof SharedDatasetError ? error.code : null);

  async function call(ctx: Ctx, deviceId: string, request: SharedDatasetsRequest): Promise<unknown> {
    const reply = await ports.invoke(deviceId, request);
    // A reply that arrives after an account switch belongs to the old account.
    ctx.scope.assertCurrent();
    if (!reply.ok) throw new SharedDatasetPeerError(reply.error.code, reply.error.message);
    return reply.result;
  }

  // ---------------------------------------------------------------- discovery

  async function readCaps(
    ctx: Ctx,
    deviceId: string,
  ): Promise<SharedDatasetCapsEntry | undefined> {
    try {
      const caps = parseSharedDatasetsCaps(
        await call(ctx, deviceId, { action: 'caps' }),
      );
      return caps?.datasets.find(
        (entry) => entry.id === ctx.id && entry.schemaVersion === ctx.def.schemaVersion,
      );
    } catch {
      // Unsupported (CHANNEL_NOT_ALLOWED), offline or remote control off: not a participant.
      ctx.scope.assertCurrent();
      return undefined;
    }
  }

  async function discover(ctx: Ctx, only?: string): Promise<Candidate[]> {
    const self = ports.selfDeviceId();
    const peers: SharedPeerFact[] = only
      ? [{ deviceId: only, name: '', online: true }]
      : (await ports.listPeers()).filter((peer) => peer.online && peer.deviceId !== self);
    ctx.scope.assertCurrent();
    const found = new Map<string, Candidate>();
    const consider = (candidate: Candidate) => {
      const current = found.get(candidate.deviceId);
      if (
        !current ||
        (candidate.confirmed && !current.confirmed) ||
        (candidate.confirmed === current.confirmed && candidate.epoch > current.epoch)
      ) {
        found.set(candidate.deviceId, candidate);
      }
    };
    for (let offset = 0; offset < peers.length; offset += CAPS_CONCURRENCY) {
      const entries = await Promise.all(
        peers.slice(offset, offset + CAPS_CONCURRENCY).map(async (peer) => ({
          peer,
          entry: await readCaps(ctx, peer.deviceId),
        })),
      );
      for (const { peer, entry } of entries) {
        if (!entry) continue;
        noteReplica(ctx.key, peer.deviceId, entry.role === 'replica' && entry.homeDeviceId === self);
        if (entry.role === 'home') {
          consider({ deviceId: peer.deviceId, epoch: entry.homeEpoch ?? 1, confirmed: true });
        } else if (entry.role === 'replica' && entry.homeDeviceId && entry.homeDeviceId !== self) {
          consider({
            deviceId: entry.homeDeviceId,
            epoch: entry.homeEpoch ?? 1,
            confirmed: false,
          });
        }
      }
    }
    return [...found.values()];
  }

  function best(candidates: Candidate[], confirmedOnly: boolean): Candidate | undefined {
    return candidates
      .filter((candidate) => candidate.confirmed || !confirmedOnly)
      .reduce<Candidate | undefined>(
        (top, candidate) => (!top || beats(candidate, top) ? candidate : top),
        undefined,
      );
  }

  // ---------------------------------------------------------------- outbox helpers

  /** The op as the home must see it: placeholder ids resolved, expectedRevision chained. */
  function rewriteForSubmit(update: SharedUpdate, outbox: Outbox): SharedUpdate {
    if (!update.id) return update;
    const id = outbox.idMap[update.id] ?? update.id;
    const next: SharedUpdate = { ...update, id };
    // Always against the home revision our edits are based on, never the optimistic mirror revision.
    const base = outbox.bases[id];
    if (base !== undefined) next.expectedRevision = base;
    return next;
  }

  /** Replay onto the mirror is a view, not a check: the revision the user saw no longer applies. */
  function rewriteForReplay(update: SharedUpdate, outbox: Outbox): SharedUpdate {
    const next: SharedUpdate = { ...update };
    delete next.expectedRevision;
    if (next.id) next.id = outbox.idMap[next.id] ?? next.id;
    return next;
  }

  /**
   * A view of an edit applied onto the mirror: the mirror's own revision of the item is what the
   * dataset's optimistic-concurrency check compares against (never the home's, which the queued
   * edit was based on), so the view is exactly "this edit on top of what is shown now".
   */
  async function onMirrorRevision(ctx: Ctx, update: SharedUpdate): Promise<SharedUpdate> {
    if (!update.id) return update;
    const shown = (await ctx.guard(() => ctx.def.readItems())).find((item: SharedItem) => item.id === update.id);
    const next: SharedUpdate = { ...update };
    if (shown) next.expectedRevision = shown.revision;
    else delete next.expectedRevision;
    return next;
  }

  /** Caller holds the file mutex (a role change reads, queues and flips as one step). */
  async function appendOpsLocked(ctx: Ctx, updates: Array<{ update: SharedUpdate; localId?: string }>) {
    if (!updates.length) return;
    const outbox = await ctx.files.readOutbox();
    for (const { update, localId } of updates) {
      if (update.id && update.expectedRevision !== undefined && outbox.bases[update.id] === undefined) {
        outbox.bases[update.id] = update.expectedRevision;
      }
      outbox.ops.push({
        sequence: outbox.nextSequence++,
        opId: randomUUID(),
        update,
        createdAt: ports.now(),
        ...(localId ? { localId } : {}),
      });
    }
    await ctx.files.writeOutbox(outbox);
  }

  /** Caller holds the file mutex. */
  async function recordConflictsLocked(ctx: Ctx, found: SharedDatasetConflict[]) {
    if (!found.length) return;
    const conflicts = await ctx.files.readConflicts();
    await ctx.files.writeConflicts([...conflicts, ...found]);
  }

  /** Carries local items that the other home does not know onto it (join and demotion). */
  function carryOverUpdates(
    ctx: Ctx,
    local: SharedItem[],
    remote: Map<string, SharedItem>,
  ): { ops: Array<{ update: SharedUpdate; localId?: string }>; conflicts: SharedDatasetConflict[] } {
    const self = ports.selfDeviceId() ?? 'self';
    const ops: Array<{ update: SharedUpdate; localId?: string }> = [];
    const conflicts: SharedDatasetConflict[] = [];
    for (const item of local) {
      const theirs = remote.get(item.id);
      if (!theirs) {
        const update = ctx.def.creationUpdate(item, importRequestId(self, item.id));
        if (update) ops.push({ update, localId: item.id });
      } else if (item.revision > theirs.revision && ctx.def.reviseUpdate) {
        const update = ctx.def.reviseUpdate(item, theirs);
        if (update) ops.push({ update: { ...update, id: item.id, expectedRevision: theirs.revision } });
      } else if (item.revision === theirs.revision && !isDeepStrictEqual(item, theirs) && ctx.def.reviseUpdate) {
        // Same revision, different content (a restored or diverged copy): never silently take either side.
        const update = ctx.def.reviseUpdate(item, theirs);
        if (update) {
          conflicts.push({
            id: randomUUID(),
            update: { ...update, id: item.id, expectedRevision: theirs.revision },
            code: 'DIVERGED',
            at: ports.now(),
            homeItem: theirs,
          });
        }
      }
    }
    return { ops, conflicts };
  }

  // ---------------------------------------------------------------- home side

  async function ownCaps(): Promise<SharedDatasetCapsEntry[]> {
    const entries: SharedDatasetCapsEntry[] = [];
    for (const def of registry.list()) {
      let ctx: Ctx;
      try {
        ctx = open(def.id);
      } catch {
        continue;
      }
      const state = await ctx.files.readState();
      entries.push({
        id: def.id,
        schemaVersion: def.schemaVersion,
        role: state.role,
        ...(state.homeDeviceId ? { homeDeviceId: state.homeDeviceId } : {}),
        ...(state.homeEpoch > 0 ? { homeEpoch: state.homeEpoch } : {}),
      });
    }
    return entries;
  }

  /**
   * Home side of the channel. `src` is the authenticated sender (never taken from the request).
   * Throws only for malformed requests; every protocol outcome is a normal reply.
   */
  async function handleRequest(src: string, arg: unknown): Promise<unknown> {
    const request = parseSharedDatasetsRequest(arg);
    if (request.action === 'caps') {
      return { version: SHARED_DATASETS_VERSION, datasets: await ownCaps() };
    }
    const def = registry.get(request.dataset);
    const notHome = (state?: DatasetState) => ({
      notHome: true as const,
      ...(state?.role === 'replica' && state.homeDeviceId ? { homeDeviceId: state.homeDeviceId } : {}),
      ...(state && state.homeEpoch > 0 ? { homeEpoch: state.homeEpoch } : {}),
    });
    if (!def) {
      return request.action === 'submit' ? { error: { code: 'NOT_HOME' } } : request.action === 'snapshot' ? notHome() : { ok: true };
    }
    const ctx = open(def.id);

    if (request.action === 'snapshot') {
      const state = await ctx.files.readState();
      if (state.role !== 'home') return notHome(state);
      noteReplica(ctx.key, src, true);
      const items = await ctx.guard(() => def.readItems());
      const extras = await ctx.guard(() => def.readExtras?.());
      const cursor = def.cursorOf(items, extras);
      if (request.cursor === cursor) return { cursor, unchanged: true };
      const reply = { cursor, items, ...(extras !== undefined ? { extras } : {}) };
      if (Buffer.byteLength(JSON.stringify(reply)) > SHARED_DATASETS_MAX_SNAPSHOT_BYTES) {
        throw new Error('SHARED_DATASETS_TOO_LARGE');
      }
      return reply;
    }

    if (request.action === 'submit') {
      // The source names the sender, and the sender is whoever the link authenticated.
      if (request.source !== `replica:${src}`) throw new Error('SHARED_DATASETS_INVALID');
      return fileMutex(ctx.key, async () => {
        const state = await ctx.files.readState();
        if (state.role !== 'home') {
          return {
            error: {
              code: 'NOT_HOME',
              ...(state.role === 'replica' && state.homeDeviceId ? { homeDeviceId: state.homeDeviceId } : {}),
              ...(state.homeEpoch > 0 ? { homeEpoch: state.homeEpoch } : {}),
            },
          } satisfies SharedDatasetsSubmitReply;
        }
        noteReplica(ctx.key, src, true);
        const receipts = await ctx.files.readReceipts();
        const last = receipts[request.source];
        const lastSequence = last?.sequence ?? 0;
        const hash = hashUpdate(request.update, request.opId);
        if (request.sequence === lastSequence && last) {
          // A retry of the op whose reply was lost. A different update under the same sequence
          // means the source lost its history (reinstall): never answer with someone else's result.
          if (last.hash === hash) return last.error ? { error: last.error } : { result: last.result };
        } else if (request.sequence === lastSequence + 1) {
          let entry: { result?: unknown; error?: { code: string; message?: string } };
          try {
            // A replica always edits against a base revision. Without one a crash between apply and
            // receipt would let the retry apply the edit a second time (complete / delete / later).
            if (request.update.id && request.update.expectedRevision === undefined) {
              throw new SharedDatasetError('INVALID_PARAMS', 'expectedRevision is required');
            }
            entry = { result: await ctx.guard(() => def.applySubmit(request.update)) };
          } catch (error) {
            const code = errorCode(def, error);
            if (!code) throw error;
            entry = { error: { code, message: error instanceof Error ? error.message.slice(0, 200) : undefined } };
          }
          // Applied before the receipt is written: a crash in between replays the op on retry,
          // which creations absorb by request id and edits report as a stale revision.
          receipts[request.source] = { sequence: request.sequence, hash, ...entry };
          await ctx.files.writeReceipts(receipts);
          if (!entry.error) {
            emitChanged(def.id);
            schedulePush(def.id);
          }
          return entry.error ? { error: entry.error } : { result: entry.result };
        }
        return { error: { code: 'OUT_OF_ORDER', expectedSequence: lastSequence + 1 } };
      });
    }

    // handover
    return syncMutex(ctx.key, async () => {
      const state = await ctx.files.readState();
      if (state.role === 'off') return { ok: true };
      if (src !== request.newHomeDeviceId) throw new Error('SHARED_DATASETS_INVALID');
      if (state.role === 'replica') {
        if (beats({ epoch: request.homeEpoch, deviceId: src }, { epoch: state.homeEpoch, deviceId: state.homeDeviceId ?? '￿' })) {
          await saveState(ctx, { ...state, homeDeviceId: src, homeEpoch: request.homeEpoch, cursor: undefined, extras: undefined });
          scheduleSync(def.id, 0, true);
        }
        return { ok: true };
      }
      if (request.homeEpoch <= state.homeEpoch) throw new Error('SHARED_DATASETS_STALE');
      await demote(ctx, { deviceId: src, epoch: request.homeEpoch, confirmed: true });
      return { ok: true };
    });
  }

  function schedulePush(id: string) {
    let scope: SharedOwnerScope;
    try {
      scope = ports.captureScope();
    } catch {
      return;
    }
    const key = `${scope.owner}\u0000${id}`;
    if (pushTimers.has(key)) return;
    pushTimers.set(
      key,
      ports.schedule(() => {
        pushTimers.delete(key);
        void pushChanged(id, key).catch((error) =>
          ports.log?.warn('shared dataset push failed', { dataset: id, code: errorCodeOf(error) }),
        );
      }, PUSH_DEBOUNCE_MS),
    );
  }

  async function pushChanged(id: string, expectedKey: string) {
    const ctx = open(id);
    if (ctx.key !== expectedKey) return;
    const state = await ctx.files.readState();
    if (state.role !== 'home') return;
    const items = await ctx.guard(() => ctx.def.readItems());
    const extras = await ctx.guard(() => ctx.def.readExtras?.());
    const frame = { dataset: id, cursor: ctx.def.cursorOf(items, extras) };
    ctx.scope.assertCurrent();
    const replicas = replicaPeers.get(ctx.key);
    for (const deviceId of ports.pushTargets()) {
      // Only computers known to follow this one (never every desktop of the account).
      if (!replicas?.has(deviceId)) continue;
      try {
        ports.sendChanged(deviceId, frame);
      } catch {
        // The replica catches up through its own trigger or the fallback timer.
      }
    }
  }

  // ---------------------------------------------------------------- replica sync

  async function settleOp(
    ctx: Ctx,
    op: OutboxOp,
    reply: { result: unknown } | { error: { code: string; message?: string } },
  ) {
    await fileMutex(ctx.key, async () => {
      const outbox = await ctx.files.readOutbox();
      if (outbox.ops[0]?.opId !== op.opId) return;
      const blocked: OutboxOp[] = [];
      if ('error' in reply) {
        // Later queued edits of the same item were written on top of the refused one: they would
        // either be refused too or, worse, land on a newer home revision. They wait for the owner.
        const ids = new Set<string>();
        for (const id of [op.update.id, op.localId]) {
          if (id) {
            ids.add(id);
            if (outbox.idMap[id]) ids.add(outbox.idMap[id]);
          }
        }
        outbox.ops.shift();
        outbox.ops = outbox.ops.filter((next) => {
          const target = next.update.id;
          if (target && (ids.has(target) || (outbox.idMap[target] && ids.has(outbox.idMap[target])))) {
            blocked.push(next);
            return false;
          }
          return true;
        });
        const conflicts = await ctx.files.readConflicts();
        for (const refused of [op, ...blocked]) {
          if (conflicts.some((conflict) => conflict.id === refused.opId)) continue;
          conflicts.push({ id: refused.opId, update: refused.update, code: reply.error.code, at: ports.now() });
        }
        await ctx.files.writeConflicts(conflicts);
      } else {
        const result = reply.result as Partial<SharedResult> | null;
        const sent = rewriteForSubmit(op.update, outbox);
        if (result && typeof result.id === 'string' && Number.isInteger(result.revision)) {
          if (!sent.id && op.localId && op.localId !== result.id) outbox.idMap[op.localId] = result.id;
          outbox.bases[result.id] = result.revision as number;
        }
        outbox.ops.shift();
      }
      await ctx.files.writeOutbox(outbox);
      for (const refused of blocked) if (refused.opId) flushWaiters.get(refused.opId)?.(null);
      if (op.opId) {
        const settled =
          'error' in reply
            ? null
            : (() => {
                const result = reply.result as Partial<SharedResult> | null;
                return result && typeof result.id === 'string' && Number.isInteger(result.revision)
                  ? { id: result.id, revision: result.revision as number }
                  : null;
              })();
        flushWaiters.get(op.opId)?.(settled);
      }
    });
  }

  async function rebase(ctx: Ctx, expected: number) {
    await fileMutex(ctx.key, async () => {
      const outbox = await ctx.files.readOutbox();
      if (outbox.ops[0]?.sequence === expected) throw new SharedDatasetPeerError('OUT_OF_ORDER');
      outbox.ops.forEach((op, index) => {
        op.sequence = expected + index;
      });
      outbox.nextSequence = expected + outbox.ops.length;
      await ctx.files.writeOutbox(outbox);
    });
  }

  async function runSync(ctx: Ctx): Promise<SyncOutcome> {
    const state = await ctx.files.readState();
    const home = state.homeDeviceId;
    if (state.role !== 'replica' || !home) return 'inactive';
    const self = ports.selfDeviceId();
    if (!self) throw new SharedDatasetPeerError('NOT_CONNECTED');

    // 1. Our queued edits first, in order, so the snapshot we take already contains them.
    for (let rebases = 0; ; ) {
      const outbox = await ctx.files.readOutbox();
      const op = outbox.ops[0];
      if (!op) break;
      const reply = parseSharedDatasetsSubmitReply(
        await call(ctx, home, {
          action: 'submit',
          dataset: ctx.id,
          source: `replica:${self}`,
          sequence: op.sequence,
          opId: op.opId,
          update: rewriteForSubmit(op.update, outbox),
        }),
      );
      if (!reply) throw new SharedDatasetPeerError('BAD_REPLY');
      if ('error' in reply) {
        if (reply.error.code === 'NOT_HOME') return 'not-home';
        if (reply.error.code === 'OUT_OF_ORDER') {
          if (!reply.error.expectedSequence || ++rebases > MAX_REBASES_PER_CYCLE) {
            throw new SharedDatasetPeerError('OUT_OF_ORDER');
          }
          await rebase(ctx, reply.error.expectedSequence);
          continue;
        }
      }
      await settleOp(ctx, op, reply);
    }

    // 2. Then what the home has.
    const snapshot: SharedDatasetsSnapshotReply | null = parseSharedDatasetsSnapshotReply(
      await call(ctx, home, {
        action: 'snapshot',
        dataset: ctx.id,
        ...(state.cursor ? { cursor: state.cursor } : {}),
      }),
    );
    if (!snapshot) throw new SharedDatasetPeerError('BAD_REPLY');
    if ('notHome' in snapshot) return 'not-home';
    if ('unchanged' in snapshot) {
      await fileMutex(ctx.key, async () => {
        const current = await ctx.files.readState();
        if (current.role === 'replica' && current.homeDeviceId === home) {
          await saveState(ctx, { ...current, lastSyncedAt: ports.now() });
        }
      });
      return 'synced';
    }
    if (!snapshot.items.every(isItem)) throw new SharedDatasetPeerError('BAD_REPLY');
    await commitSnapshot(ctx, home, snapshot.cursor, snapshot.items as SharedItem[], snapshot.extras);
    return 'synced';
  }

  async function commitSnapshot(
    ctx: Ctx,
    home: string,
    cursor: string,
    items: SharedItem[],
    extras: unknown,
  ) {
    await fileMutex(ctx.key, async () => {
      const state = await ctx.files.readState();
      // A role change cannot overlap (same sync lock), but a stale reply must never be applied.
      if (state.role !== 'replica' || state.homeDeviceId !== home) return;
      const outbox = await ctx.files.readOutbox();
      const snapshotIds = new Set(items.map((item) => item.id));
      // Placeholders of creations still queued must survive; everything else the home does not
      // list (flushed creations included, now represented by the home's own item) goes.
      const pending = new Set(
        outbox.ops.filter((op) => op.localId && !outbox.idMap[op.localId]).map((op) => op.localId as string),
      );
      const mirror = await ctx.guard(() => ctx.def.readItems());
      const removeIds = mirror
        .map((item) => item.id)
        .filter((id) => !snapshotIds.has(id) && !pending.has(id));
      await ctx.guard(() => ctx.def.replaceMirror(items, removeIds));
      for (const op of outbox.ops) {
        try {
          const view = await onMirrorRevision(ctx, rewriteForReplay(op.update, outbox));
          await ctx.guard(() => ctx.def.applySubmit(view));
        } catch (error) {
          // The view of a queued edit that cannot be applied is simply missing; the home decides
          // when the op is submitted. Only an account switch must stop the commit.
          ctx.scope.assertCurrent();
        }
      }
      const referenced = new Set(
        outbox.ops.flatMap((op) => (op.update.id ? [outbox.idMap[op.update.id] ?? op.update.id] : [])),
      );
      const rawReferenced = new Set(outbox.ops.flatMap((op) => (op.update.id ? [op.update.id] : [])));
      outbox.idMap = Object.fromEntries(Object.entries(outbox.idMap).filter(([local]) => rawReferenced.has(local)));
      outbox.bases = Object.fromEntries(Object.entries(outbox.bases).filter(([id]) => referenced.has(id)));
      await ctx.files.writeOutbox(outbox);

      const byId = new Map(items.map((item) => [item.id, item]));
      const conflicts = await ctx.files.readConflicts();
      let filled = false;
      for (const conflict of conflicts) {
        const id = conflict.update.id ? outbox.idMap[conflict.update.id] ?? conflict.update.id : undefined;
        const item = id ? byId.get(id) : undefined;
        if (item && conflict.homeItem === undefined) {
          conflict.homeItem = item;
          filled = true;
        }
      }
      if (filled) await ctx.files.writeConflicts(conflicts);
      await saveState(ctx, { ...state, cursor, extras, lastSyncedAt: ports.now() });
    });
    emitChanged(ctx.id);
  }

  /** One sync cycle (flush, snapshot, commit) and, when the home moved, the re-discovery. */
  async function sync(id: string): Promise<'synced' | 'inactive'> {
    const ctx = open(id);
    const outcome = await syncMutex(ctx.key, () => runSync(ctx));
    if (outcome !== 'not-home') return outcome;
    const before = await ctx.files.readState();
    await reconcile(id);
    const after = await ctx.files.readState();
    if (after.role !== 'replica') return 'inactive';
    if (after.homeDeviceId === before.homeDeviceId) {
      // Nobody better was found: back off instead of asking the same home again at once.
      throw new SharedDatasetPeerError('NOT_HOME');
    }
    scheduleSync(id, 0, true);
    return 'synced';
  }

  // ---------------------------------------------------------------- scheduling

  function schedulerFor(key: string): Scheduler {
    let scheduler = schedulers.get(key);
    if (!scheduler) {
      scheduler = { failures: 0, running: false, rerun: false };
      schedulers.set(key, scheduler);
    }
    return scheduler;
  }

  function backoff(failures: number): number {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10));
    return Math.round(delay * (0.8 + Math.random() * 0.4));
  }

  /** Coalesced, backed-off sync trigger. Never polls tighter than the backoff allows. */
  function scheduleSync(id: string, delayMs = TRIGGER_DEBOUNCE_MS, force = false) {
    let scope: SharedOwnerScope;
    try {
      scope = ports.captureScope();
    } catch {
      return;
    }
    const key = `${scope.owner}\u0000${id}`;
    const scheduler = schedulerFor(key);
    if (scheduler.running) {
      scheduler.rerun = force ? 'force' : scheduler.rerun || 'normal';
      return;
    }
    // Local edits keep their place in the backoff; the home coming back (push, presence) does not wait.
    if (!force && scheduler.failures > 0 && scheduler.cancel) return;
    scheduler.cancel?.();
    scheduler.cancel = ports.schedule(() => void runScheduled(id, key, scope.owner), delayMs);
  }

  async function runScheduled(id: string, key: string, owner: string) {
    const scheduler = schedulerFor(key);
    scheduler.cancel = undefined;
    scheduler.running = true;
    let next: number | null = SYNC_FALLBACK_MS;
    let failed = false;
    try {
      const outcome = await sync(id);
      scheduler.failures = 0;
      scheduler.lastError = undefined;
      if (outcome === 'inactive') next = null;
    } catch (error) {
      let current: string | null = null;
      try {
        current = ports.captureScope().owner;
      } catch {
        current = null;
      }
      if (current !== owner) {
        // Another account is active now; it restarts its own syncs when its session starts.
        next = null;
      } else {
        failed = true;
        scheduler.failures += 1;
        scheduler.lastError = errorCodeOf(error);
        next = backoff(scheduler.failures);
        ports.log?.warn('shared dataset sync failed', { dataset: id, code: scheduler.lastError });
      }
    } finally {
      scheduler.running = false;
    }
    emitStatus(id);
    if (scheduler.rerun) {
      const mode = scheduler.rerun;
      scheduler.rerun = false;
      // A local edit made during a failed run must not bypass the backoff; the home coming back may.
      if (next !== null && (!failed || mode === 'force')) next = Math.min(next, TRIGGER_DEBOUNCE_MS);
    }
    if (next === null) {
      schedulers.delete(key);
      return;
    }
    scheduler.cancel = ports.schedule(() => void runScheduled(id, key, owner), next);
  }

  // ---------------------------------------------------------------- role changes

  /** The other home's items by id, to tell what it already has from what must be carried over. */
  async function fetchRemoteItems(ctx: Ctx, deviceId: string): Promise<Map<string, SharedItem>> {
    const snapshot = parseSharedDatasetsSnapshotReply(
      await call(ctx, deviceId, { action: 'snapshot', dataset: ctx.id }),
    );
    if (!snapshot || 'notHome' in snapshot || !('items' in snapshot) || !snapshot.items.every(isItem)) {
      throw new SharedDatasetPeerError('NOT_HOME');
    }
    return new Map((snapshot.items as SharedItem[]).map((item) => [item.id, item]));
  }

  /** Home → replica of `target`: carry what the new home does not have, then follow it. */
  async function demote(ctx: Ctx, target: Candidate) {
    // The new home must answer before we give anything up; offline → stay home and retry later.
    const remote = await fetchRemoteItems(ctx, target.deviceId);
    // Read, queue and flip as one step: a local write (also under the file mutex) lands either
    // before the read (and is carried) or after the flip (and goes to the replica queue).
    await fileMutex(ctx.key, async () => {
      const state = await ctx.files.readState();
      const local = await ctx.guard(() => ctx.def.readItems());
      const carried = carryOverUpdates(ctx, local, remote);
      // Queued before the role flips: a crash in between repeats idempotent creations, never loses them.
      await appendOpsLocked(ctx, carried.ops);
      await recordConflictsLocked(ctx, carried.conflicts);
      replicaPeers.delete(ctx.key);
      await saveState(ctx, {
        role: 'replica',
        homeDeviceId: target.deviceId,
        homeEpoch: target.epoch,
        lastSyncedAt: state.lastSyncedAt,
      });
    });
    scheduleSync(ctx.id, 0, true);
    emitChanged(ctx.id);
  }

  /** Looks at the other computers and follows a better home, or stands down in its favour. */
  async function reconcile(id: string, only?: string) {
    const ctx = open(id);
    const throttle = `${ctx.key}\u0000${only ?? '*'}`;
    const now = ports.now();
    if (now - (lastDiscovery.get(throttle) ?? -Infinity) < DISCOVERY_MIN_INTERVAL_MS) return;
    lastDiscovery.set(throttle, now);
    const candidates = await discover(ctx, only);
    const top = best(candidates, true);
    if (!top) return;
    await syncMutex(ctx.key, async () => {
      const state = await ctx.files.readState();
      if (state.role === 'home') {
        const self = ports.selfDeviceId();
        if (self && beats(top, { epoch: state.homeEpoch, deviceId: self })) await demote(ctx, top);
      } else if (state.role === 'replica' && state.homeDeviceId) {
        if (top.deviceId === state.homeDeviceId) {
          if (top.epoch > state.homeEpoch) await saveState(ctx, { ...state, homeEpoch: top.epoch });
        } else if (beats(top, { epoch: state.homeEpoch, deviceId: state.homeDeviceId })) {
          await saveState(ctx, { ...state, homeDeviceId: top.deviceId, homeEpoch: top.epoch, cursor: undefined, extras: undefined });
          scheduleSync(id, 0, true);
        }
      }
    });
  }

  async function enable(id: string): Promise<SharedDatasetSyncStatus> {
    const ctx = open(id);
    await syncMutex(ctx.key, async () => {
      const state = await ctx.files.readState();
      if (state.role !== 'off') return;
      const self = ports.selfDeviceId();
      if (!self) throw new SharedDatasetPeerError('NOT_CONNECTED');
      const candidate = best(await discover(ctx), false);
      if (candidate) {
        // Without the home's items we could not tell what it already has (a re-join would
        // duplicate everything), so joining needs the home online.
        const remote = await fetchRemoteItems(ctx, candidate.deviceId);
        await fileMutex(ctx.key, async () => {
          const local = await ctx.guard(() => ctx.def.readItems());
          const carried = carryOverUpdates(ctx, local, remote);
          await appendOpsLocked(ctx, carried.ops);
          await recordConflictsLocked(ctx, carried.conflicts);
          await saveState(ctx, { role: 'replica', homeDeviceId: candidate.deviceId, homeEpoch: candidate.epoch });
        });
        scheduleSync(id, 0, true);
      } else {
        await fileMutex(ctx.key, async () => {
          await ctx.files.writeReceipts({});
          await saveState(ctx, { role: 'home', homeDeviceId: self, homeEpoch: Math.max(1, state.homeEpoch + 1) });
        });
        schedulePush(id);
      }
    });
    emitChanged(id);
    return getSyncStatus(id);
  }

  async function disable(id: string): Promise<void> {
    const ctx = open(id);
    await syncMutex(ctx.key, () =>
      fileMutex(ctx.key, async () => {
        const state = await ctx.files.readState();
        if (state.role === 'off') return;
        // The mirror stays as this computer's own data; queued edits are already in it.
        const outbox = await ctx.files.readOutbox();
        await ctx.files.writeOutbox({ nextSequence: outbox.nextSequence, ops: [], idMap: {}, bases: {} });
        await ctx.files.writeConflicts([]);
        await saveState(ctx, { role: 'off', homeEpoch: state.homeEpoch });
      }),
    );
    const scheduler = schedulers.get(ctx.key);
    scheduler?.cancel?.();
    schedulers.delete(ctx.key);
    emitChanged(id);
  }

  async function setAsHome(id: string): Promise<void> {
    const ctx = open(id);
    const self = ports.selfDeviceId();
    if (!self) throw new SharedDatasetPeerError('NOT_CONNECTED');
    const before = await ctx.files.readState();
    if (before.role === 'home') return;
    if (before.role !== 'replica') throw new SharedDatasetError('NOT_ENABLED');
    // Best effort: with the old home reachable we take its latest state and queued edits land
    // there first; offline we take over from the local mirror (which already shows our edits).
    await sync(id).catch((error) => {
      ctx.scope.assertCurrent();
      ports.log?.warn('set-as-home pre-sync failed', { dataset: id, code: errorCodeOf(error) });
    });
    let oldHome: string | undefined;
    let epoch = 1;
    await syncMutex(ctx.key, () =>
      fileMutex(ctx.key, async () => {
        const state = await ctx.files.readState();
        if (state.role !== 'replica') return;
        oldHome = state.homeDeviceId;
        epoch = state.homeEpoch + 1;
        const outbox = await ctx.files.readOutbox();
        await ctx.files.writeOutbox({ nextSequence: outbox.nextSequence, ops: [], idMap: {}, bases: {} });
        // Edits the previous home refused no longer apply: this computer's data is the authority now.
        await ctx.files.writeConflicts([]);
        // A new epoch starts without receipts; replicas rebase their sequences on OUT_OF_ORDER.
        await ctx.files.writeReceipts({});
        await saveState(ctx, { role: 'home', homeDeviceId: self, homeEpoch: epoch });
      }),
    );
    if (oldHome && oldHome !== self) {
      try {
        await call(ctx, oldHome, { action: 'handover', dataset: id, newHomeDeviceId: self, homeEpoch: epoch });
      } catch {
        // Offline: it stands down by itself when it sees the higher epoch.
        ctx.scope.assertCurrent();
      }
    }
    schedulePush(id);
    emitChanged(id);
  }

  // ---------------------------------------------------------------- replica writes

  /**
   * The one write entry. Under the dataset's file mutex it reads the role and then either runs the
   * dataset's own write (`localWrite`, off / home) or queues the edit for the home (replica), so a
   * concurrent demotion can never wipe an edit that landed in the mirror just before the flip.
   */
  async function writeDataset<T>(
    id: string,
    update: SharedUpdate,
    options: { optimisticUpdate?: SharedUpdate; waitMs?: number; localWrite?: () => Promise<T> } = {},
  ): Promise<{ local: true; value: T } | { local: false; result: SharedResult & { synced?: SharedResult } }> {
    let ctx: Ctx;
    try {
      ctx = open(id);
    } catch (error) {
      // No active account / unknown dataset: a plain local dataset.
      if (!options.localWrite) throw error;
      return { local: true, value: await options.localWrite() };
    }
    const opId = randomUUID();
    let flushed: Promise<SharedResult | null> | undefined;
    if (options.waitMs) {
      // Registered before the op exists: the flush can never settle it ahead of the waiter.
      flushed = new Promise<SharedResult | null>((resolve) => {
        flushWaiters.set(opId, resolve);
      });
    }
    const outcome = await fileMutex(ctx.key, async () => {
      const state = await ctx.files.readState();
      if (state.role !== 'replica') {
        if (!options.localWrite) throw new SharedDatasetError('NOT_REPLICA');
        return { local: true as const, value: await ctx.guard(options.localWrite) };
      }
      const before = await ctx.files.readOutbox();
      const outbox = structuredClone(before);
      // Base revision on the home for edits of an existing item: the first queued edit takes the
      // revision the user saw (= the home's, the mirror had no queued edit on it); later ones keep
      // it until an accepted op moves it. The optimistic mirror revision never reaches the home.
      if (update.id) {
        const realId = outbox.idMap[update.id] ?? update.id;
        const placeholder = !outbox.idMap[update.id] && outbox.ops.some((op) => op.localId === update.id);
        if (!placeholder && outbox.bases[realId] === undefined) {
          const base =
            update.expectedRevision ??
            (await ctx.guard(() => ctx.def.readItems())).find((item: SharedItem) => item.id === update.id)?.revision;
          if (base !== undefined) outbox.bases[realId] = base;
        }
      }
      const op: OutboxOp = { sequence: outbox.nextSequence++, opId, update, createdAt: ports.now() };
      outbox.ops.push(op);
      // Queued first: a crash after the optimistic apply must not lose the edit.
      await ctx.files.writeOutbox(outbox);
      try {
        const applied = await ctx.guard(() => ctx.def.applySubmit(options.optimisticUpdate ?? update));
        if (!update.id) {
          op.localId = applied.id;
          await ctx.files.writeOutbox(outbox);
        }
        return { local: false as const, result: applied };
      } catch (error) {
        // Refused locally: the home would refuse it too, so it is an error for the caller.
        await ctx.files.writeOutbox(before);
        throw error;
      }
    }).catch((error) => {
      flushWaiters.delete(opId);
      throw error;
    });
    if (outcome.local) {
      flushWaiters.delete(opId);
      return outcome;
    }
    emitChanged(id);
    scheduleSync(id);
    if (!flushed) return outcome;
    // Bounded wait on the engine's own flush: no extra requests, only the sync already scheduled.
    let cancel = () => {};
    const timeout = new Promise<null>((resolve) => {
      cancel = ports.schedule(() => resolve(null), options.waitMs as number);
    });
    try {
      const settled = await Promise.race([flushed, timeout]);
      return { local: false, result: settled ? { ...outcome.result, synced: settled } : outcome.result };
    } finally {
      cancel();
      flushWaiters.delete(opId);
    }
  }

  async function enqueueReplicaUpdate(
    id: string,
    update: SharedUpdate,
    options: { optimisticUpdate?: SharedUpdate; waitMs?: number } = {},
  ): Promise<SharedResult & { synced?: SharedResult }> {
    const outcome = await writeDataset(id, update, options);
    if (outcome.local) throw new SharedDatasetError('NOT_REPLICA');
    return outcome.result;
  }

  async function listConflicts(id: string): Promise<SharedDatasetConflict[]> {
    return open(id).files.readConflicts();
  }

  async function resolveConflict(id: string, conflictId: string, choice: ConflictChoice): Promise<void> {
    const ctx = open(id);
    const conflicts = await ctx.files.readConflicts();
    const conflict = conflicts.find((entry) => entry.id === conflictId);
    if (!conflict) throw new SharedDatasetError('NOT_FOUND');
    if (choice === 'mine') {
      const renewed = !conflict.update.id && ctx.def.renewCreation ? ctx.def.renewCreation(conflict.update) : conflict.update;
      const update: SharedUpdate = { ...renewed };
      const optimisticUpdate = await onMirrorRevision(ctx, renewed);
      if (update.id) {
        const fresh =
          (conflict.homeItem as SharedItem | undefined) ??
          (await ctx.guard(() => ctx.def.readItems())).find((item: SharedItem) => item.id === update.id);
        if (fresh) update.expectedRevision = fresh.revision;
        else delete update.expectedRevision;
      }
      await enqueueReplicaUpdate(id, update, { optimisticUpdate });
    }
    await fileMutex(ctx.key, async () => {
      const current = await ctx.files.readConflicts();
      await ctx.files.writeConflicts(current.filter((entry) => entry.id !== conflictId));
    });
    emitChanged(id);
  }

  // ---------------------------------------------------------------- status & lifecycle

  async function getSyncStatus(id: string): Promise<SharedDatasetSyncStatus> {
    const ctx = open(id);
    const state = await ctx.files.readState();
    const outbox = state.role === 'replica' ? await ctx.files.readOutbox() : null;
    const conflicts = state.role === 'off' ? [] : await ctx.files.readConflicts();
    const home = state.homeDeviceId;
    return {
      role: state.role,
      ...(home ? { homeDeviceId: home } : {}),
      ...(home && ports.peerName(home) ? { homeName: ports.peerName(home) } : {}),
      homeOnline: state.role === 'home' || (!!home && ports.isPeerOnline(home)),
      pending: outbox?.ops.length ?? 0,
      conflicts: conflicts.length,
      ...(state.lastSyncedAt ? { lastSyncedAt: state.lastSyncedAt } : {}),
      ...(schedulers.get(ctx.key)?.lastError ? { lastError: schedulers.get(ctx.key)!.lastError } : {}),
    };
  }

  async function getExtras(id: string): Promise<unknown> {
    return (await open(id).files.readState()).extras;
  }

  async function getRole(id: string): Promise<SharedDatasetRole> {
    const ctx = open(id);
    const cached = roles.get(ctx.key);
    if (cached) return cached;
    const role = (await ctx.files.readState()).role;
    roles.set(ctx.key, role);
    return role;
  }

  function onLocalWrite(id: string) {
    void (async () => {
      try {
        if ((await getRole(id)) === 'home') schedulePush(id);
      } catch {
        // No active account or unreadable state: nothing to announce.
      }
    })();
  }

  /** Datasets of the active account that are on; everything else stays untouched. */
  async function resume(): Promise<void> {
    for (const def of registry.list()) {
      if (!unsubscribeLocal.has(def.id)) {
        unsubscribeLocal.set(def.id, def.onLocalChange(() => onLocalWrite(def.id)));
      }
      try {
        const ctx = open(def.id);
        const state = await ctx.files.readState();
        roles.set(ctx.key, state.role);
        if (state.role === 'replica') {
          if (!schedulers.has(ctx.key)) scheduleSync(def.id, 0, true);
        } else if (state.role === 'home' && !resumed.has(ctx.key)) {
          // Once per start: a later (periodic) resume must not poll every desktop again.
          resumed.add(ctx.key);
          void reconcile(def.id).catch(() => undefined);
        }
      } catch {
        // No active account (or its files unreadable): resumed on the next session start.
      }
    }
  }

  /** Account boundary: drop timers and cached roles; `resume` restarts the new account's syncs. */
  function suspend() {
    for (const scheduler of schedulers.values()) scheduler.cancel?.();
    schedulers.clear();
    for (const cancel of pushTimers.values()) cancel();
    pushTimers.clear();
    roles.clear();
    resumed.clear();
    replicaPeers.clear();
  }

  function stop() {
    suspend();
    for (const unsubscribe of unsubscribeLocal.values()) unsubscribe();
    unsubscribeLocal.clear();
  }

  /** The home pushed `changed`: a replica re-reads, anyone else checks who the home is. */
  function handleChangedPush(src: string, payload: unknown) {
    const message = parseSharedDatasetsChangedPush(payload);
    if (!message || !registry.get(message.dataset)) return;
    void (async () => {
      const ctx = open(message.dataset);
      const state = await ctx.files.readState();
      if (state.role === 'off') return;
      if (state.role === 'replica' && state.homeDeviceId === src) {
        if (state.cursor !== message.cursor) scheduleSync(message.dataset, TRIGGER_DEBOUNCE_MS, true);
      } else {
        await reconcile(message.dataset, src);
      }
    })().catch((error) =>
      ports.log?.warn('shared dataset push ignored', { dataset: message.dataset, code: errorCodeOf(error) }),
    );
  }

  /** Reachability of a peer changed (online, offline, remote control toggled): refresh the status, retry the home. */
  function onPeerPresence(deviceId: string) {
    void (async () => {
      for (const def of registry.list()) {
        const ctx = open(def.id);
        const state = await ctx.files.readState();
        if (state.role === 'off') continue;
        if (state.role === 'replica' && state.homeDeviceId === deviceId && ports.isPeerOnline(deviceId)) {
          // Includes a home that just switched remote control back on; a failure is reported as lastError.
          scheduleSync(def.id, TRIGGER_DEBOUNCE_MS, true);
        }
        emitStatus(def.id);
      }
    })().catch(() => undefined);
  }

  /** A same-account desktop came online: follow/sync with it, or settle who is home. */
  function onPeerOnline(deviceId: string) {
    const now = ports.now();
    if (now - (peerSeen.get(deviceId) ?? -Infinity) < DISCOVERY_MIN_INTERVAL_MS) return;
    peerSeen.set(deviceId, now);
    void (async () => {
      for (const def of registry.list()) {
        const ctx = open(def.id);
        const state = await ctx.files.readState();
        if (state.role === 'off') continue;
        if (state.role === 'replica' && state.homeDeviceId === deviceId) scheduleSync(def.id, 0, true);
        else await reconcile(def.id, deviceId);
      }
    })().catch(() => undefined);
  }

  return {
    handleRequest,
    handleChangedPush,
    onPeerOnline,
    onPeerPresence,
    resume,
    suspend,
    stop,
    getRole,
    getExtras,
    enable,
    disable,
    setAsHome,
    enqueueReplicaUpdate,
    writeDataset,
    listConflicts,
    resolveConflict,
    getSyncStatus,
    /** Runs one cycle now (UI "sync now", tests). Rejects when the home cannot be reached. */
    syncNow: sync,
    reconcile,
    onStatusChanged(listener: (datasetId: string) => void): () => void {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onChanged(listener: (datasetId: string) => void): () => void {
      changedListeners.add(listener);
      return () => changedListeners.delete(listener);
    },
  };
}

export type SharedDatasetsEngine = ReturnType<typeof createSharedDatasetsEngine>;
