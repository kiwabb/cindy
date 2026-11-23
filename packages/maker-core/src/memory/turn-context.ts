import { createHash } from 'node:crypto';
import { HOST_TURN_CONTEXT } from '../agents/shared/host-turn-context.js';
import type { Session, SessionSendOptions, SessionSendResult } from '../session.js';
import { isTerminalAgentErrorEvent, type AgentEvent } from '../types/events.js';
import type { MakerMemoryStore } from './store.js';

export interface MemoryTurnReceipt {
  version: 1;
  scope: string;
  requestId: string;
  inputHash: string;
  replyHash: string;
  memoryFiles: string[];
  recovery?: MemoryRecoveryLineage;
}

/** Implementations must atomically retain an existing receipt, never overwrite it. */
export interface MemoryTurnReceiptStore {
  get(scope: string, requestId: string): Promise<MemoryTurnReceipt | null>;
  commitOnce(receipt: MemoryTurnReceipt, signal?: AbortSignal): Promise<void>;
}

export interface MemoryTurnContribution {
  readonly revision: number;
  readonly text: string;
  readonly sourceRefs: readonly string[];
}
export function validateMemoryTurnContribution(value: unknown): asserts value is MemoryTurnContribution {
  const item = value as MemoryTurnContribution | null;
  if (!item || !Number.isSafeInteger(item.revision) || item.revision < 0
    || typeof item.text !== 'string' || item.text.length > 4096
    || !Array.isArray(item.sourceRefs) || item.sourceRefs.length > 32
    || item.sourceRefs.some(ref => typeof ref !== 'string' || ref.length > 300))
    throw new Error('INVALID_MEMORY_TURN_CONTRIBUTION');
}

export interface MemoryTurnContextDeps {
  /** Main-only pure-state contribution, captured once; recovery never calls it again. */
  contribute?: (signal: AbortSignal) => Promise<MemoryTurnContribution>;

  /** Host-authenticated account + bot scope, not a display name or caller-supplied path. */
  scope: string;
  memory: Pick<MakerMemoryStore, 'search'> & { read(filename: string): Promise<{ body: string }> };
  receipts: MemoryTurnReceiptStore;
  snapshots?: MemoryTurnSnapshotStore;
  verifyPersistedRecall?: boolean;
  preparationTimeoutMs?: number;
  hostTerminals?: boolean;
  completionTimeoutMs?: number;
  /** Must reject a stale account, bot binding, or disposed runtime. */
  assertCurrent(): void;
}

export type MemoryTurnSettlement = 'committed' | 'not-completed';
export type MemoryTurnDispatch =
  | { kind: 'already-completed' }
  | { kind: 'dispatched'; dispatch: SessionSendResult; settled: Promise<MemoryTurnSettlement> };

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Bounded lexical recall; full natural-language questions are often too strict for FTS. */
export async function searchTurnMemories(memory: Pick<MakerMemoryStore, 'search'>, query: string,
  signal: AbortSignal): ReturnType<MakerMemoryStore['search']> {
  const text = query.trim().slice(0, 2000);
  if (!text) return [];
  signal.throwIfAborted();
  const direct = await memory.search(text, { limit: 5 });
  signal.throwIfAborted();
  if (direct.length) return direct;
  // Prefer identifiers/names; then a few CJK phrases. This is lexical, not semantic retrieval.
  const candidates = [...new Set([
    ...(text.match(/[a-zA-Z][a-zA-Z0-9_-]{2,63}/g) ?? []),
    ...(text.match(/[\p{Script=Han}]{2,24}/gu) ?? []),
  ])].filter(term => term !== text).slice(0, 3);
  const hits: Awaited<ReturnType<MakerMemoryStore['search']>> = [];
  for (const term of candidates) {
    signal.throwIfAborted();
    const found = await memory.search(term, { limit: 5 });
    signal.throwIfAborted();
    for (const hit of found) if (!hits.some(existing => existing.filename === hit.filename)) hits.push(hit);
    if (hits.length >= 5) break;
  }
  return hits.slice(0, 5);
}

export interface MemoryRecoveryLineage {
  sourceRequestId: string;
  logicalRequestId: string;
  logicalInputHash: string;
}
export interface MemoryTurnSnapshot {
  version: 1;
  scope: string;
  requestId: string;
  inputHash: string;
  recalled: Array<{ file: string; title: string; excerpt: string }>;
  contribution?: MemoryTurnContribution;
  recovery?: MemoryRecoveryLineage;
  userSource?: { messageId: string; text: string };
}
export interface MemoryTurnSnapshotStore {
  get(scope: string, requestId: string): Promise<MemoryTurnSnapshot | null>;
  prepareOnce(snapshot: MemoryTurnSnapshot, signal: AbortSignal): Promise<MemoryTurnSnapshot>;
}
/** Resolve only immutable snapshots in the binding's authenticated scope; no supplied hash. */
export async function resolveMemoryRecovery(store: MemoryTurnSnapshotStore, scope: string,
  attemptId: string, sourceRequestId: string, assertCurrent: () => void, requireInheritedSource = false): Promise<{
    recovery: MemoryRecoveryLineage; recalled: MemoryTurnSnapshot['recalled']; contribution?: MemoryTurnContribution; userSource?: MemoryTurnSnapshot['userSource'];
  }> {
  const seen = new Set([attemptId]);
  const chain: MemoryTurnSnapshot[] = [];
  let id = sourceRequestId;
  for (let depth = 0; depth < 32; depth++) {
    assertCurrent();
    if (!id || id.length > 200 || seen.has(id)) throw new Error('MEMORY_RECOVERY_CYCLE');
    seen.add(id);
    const saved = await store.get(scope, id); assertCurrent();
    if (!saved) throw new Error('MEMORY_RECOVERY_SOURCE_MISSING');
    if (saved.scope !== scope || saved.requestId !== id) throw new Error('MEMORY_RECOVERY_SCOPE_CHANGED');
    if (depth === 0 && requireInheritedSource && !saved.recovery) throw new Error('MEMORY_RECOVERY_SOURCE_UNLINKED');
    chain.push(saved);
    if (saved.recovery) { id = saved.recovery.sourceRequestId; continue; }
    const root = saved;
    for (const member of chain) if (member.recovery && (
      member.recovery.logicalRequestId !== root.requestId || member.recovery.logicalInputHash !== root.inputHash
      || JSON.stringify(member.recalled) !== JSON.stringify(root.recalled)
      || JSON.stringify(member.contribution) !== JSON.stringify(root.contribution)
      || JSON.stringify(member.userSource) !== JSON.stringify(root.userSource))) throw new Error('MEMORY_RECOVERY_LINEAGE_CHANGED');
    return { recovery: { sourceRequestId, logicalRequestId: root.requestId, logicalInputHash: root.inputHash },
      recalled: structuredClone(root.recalled), ...(root.contribution ? { contribution: structuredClone(root.contribution) } : {}), ...(root.userSource ? { userSource: structuredClone(root.userSource) } : {}) };
  }
  throw new Error('MEMORY_RECOVERY_DEPTH_EXCEEDED');
}
export interface PreparedMemoryTurn {
  readonly userSource?: MemoryTurnSnapshot['userSource'];
  readonly logicalRequestId: string;
  terminal(event: AgentEvent): void;
  settled: Promise<MemoryTurnSettlement>;
  augment(options: SessionSendOptions): SessionSendOptions;
  accepted(result: SessionSendResult): void;
  cancel(): void;
}

/** Bounds waiting, not arbitrary storage IO. Late results cannot dispatch a turn. */
function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Opt-in composition; retains the host's original send transaction and event stream. */
export class MemoryTurnContext {
  private busy = false;
  private prepared?: MemoryTurnSnapshot;

  constructor(private readonly deps: MemoryTurnContextDeps) {}

  async prepare(
    session: Pick<Session, 'onEvent' | 'onStatusChange'>,
    requestId: string,
    input: { identity: string; query: string; userSource?: MemoryTurnSnapshot['userSource']; inheritFrom?: string; requireInheritedSource?: boolean },
    options: Pick<SessionSendOptions, 'signal'> & { assertRecoveryCurrent?: () => void } = {},
  ): Promise<PreparedMemoryTurn | { kind: 'already-completed' }> {
    if (this.busy) throw new Error('MEMORY_TURN_BUSY');
    if (!requestId || requestId.length > 200 || !this.deps.scope) throw new Error('INVALID_MEMORY_TURN');
    this.busy = true;
    let release: (() => void) | undefined;
    const preparation = new AbortController();
    const abortPreparation = () => preparation.abort(options.signal?.reason ?? new Error('MEMORY_TURN_CANCELLED'));
    options.signal?.addEventListener('abort', abortPreparation, { once: true });
    if (options.signal?.aborted) abortPreparation();
    const timeout = setTimeout(() => preparation.abort(new Error('MEMORY_TURN_PREPARATION_TIMEOUT')),
      this.deps.preparationTimeoutMs ?? 1500);
    const current = () => { preparation.signal.throwIfAborted(); this.deps.assertCurrent(); options.assertRecoveryCurrent?.(); };
    try {
      current();
      const inputHash = digest(input.identity);
      if (input.inheritFrom && (!this.deps.snapshots || !options.assertRecoveryCurrent)) throw new Error('MEMORY_RECOVERY_PROOF_REQUIRED');
      const inherited = input.inheritFrom
        ? await bounded(() => resolveMemoryRecovery(this.deps.snapshots!, this.deps.scope, requestId, input.inheritFrom!, current, input.requireInheritedSource), preparation.signal)
        : undefined;
      current();
      const existing = await bounded(() => this.deps.receipts.get(this.deps.scope, requestId), preparation.signal);
      current();
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error('MEMORY_TURN_ID_CONFLICT');
        if (JSON.stringify(existing.recovery) !== JSON.stringify(inherited?.recovery)) throw new Error('MEMORY_RECOVERY_LINEAGE_CHANGED');
        this.busy = false;
        return { kind: 'already-completed' };
      }
      if (this.deps.snapshots) {
        this.prepared = await bounded(() => this.deps.snapshots!.get(this.deps.scope, requestId), preparation.signal) ?? undefined;
        current();
      }
      if (this.prepared?.requestId === requestId && this.prepared.inputHash !== inputHash) {
        throw new Error('MEMORY_TURN_ID_CONFLICT');
      }
      if (this.prepared?.requestId === requestId
        && JSON.stringify(this.prepared.recovery) !== JSON.stringify(inherited?.recovery)) throw new Error('MEMORY_RECOVERY_LINEAGE_CHANGED');
      if (this.prepared?.requestId !== requestId && inherited) {
        this.prepared = { version: 1, scope: this.deps.scope, requestId, inputHash, ...inherited };
      }
      const needsRecall = this.prepared?.requestId !== requestId;
      if (this.prepared?.requestId !== requestId) {
        const hits = input.query.trim()
          ? await bounded(() => searchTurnMemories(this.deps.memory, input.query, preparation.signal), preparation.signal) : [];
        current();
        const recalled: MemoryTurnSnapshot['recalled'] = [];
        for (const hit of hits.slice(0, 5)) {
          // FTS may choose a title/description snippet; it is not the recalled fact.
          // Read through the same owner-scoped store and existing preparation deadline.
          const record = await bounded(() => this.deps.memory.read(hit.filename), preparation.signal);
          current();
          recalled.push({ file: hit.filename.slice(0, 240), title: hit.title.slice(0, 160),
            excerpt: record.body.slice(0, 500) });
        }
        const contribution = this.deps.contribute
          ? await bounded(() => this.deps.contribute!(preparation.signal), preparation.signal) : undefined;
        current();
        if (contribution !== undefined) validateMemoryTurnContribution(contribution);
        this.prepared = { version: 1, scope: this.deps.scope, requestId, inputHash, recalled,
          ...(contribution !== undefined ? { contribution: structuredClone(contribution) } : {}), ...(input.userSource ? { userSource: structuredClone(input.userSource) } : {}) };
      }
      if (this.deps.snapshots) {
        const candidate = this.prepared;
        this.prepared = await bounded(() => this.deps.snapshots!.prepareOnce(candidate, preparation.signal), preparation.signal);
        current();
      }
      if (inherited && JSON.stringify(this.prepared.contribution) !== JSON.stringify(inherited.contribution))
        throw new Error('MEMORY_RECOVERY_LINEAGE_CHANGED');
      let recalled = this.prepared.recalled;
      if (!needsRecall && this.deps.verifyPersistedRecall) {
        const checked: typeof recalled = [];
        for (const entry of recalled) {
          const live = await bounded(() => this.deps.memory.read(entry.file), preparation.signal)
            .catch(() => undefined);
          current();
          if (live?.body.slice(0, 500) === entry.excerpt) checked.push(entry);
        }
        recalled = checked;
      }
      const contribution = this.prepared.contribution ? structuredClone(this.prepared.contribution) : undefined;
      const completion = new AbortController();
      let generation: number | undefined;
      let accepted = false;
      let terminal: AgentEvent | undefined;
      let finished = false;
      let resolve!: (result: MemoryTurnSettlement) => void;
      let reject!: (error: unknown) => void;
      const settled = new Promise<MemoryTurnSettlement>((yes, no) => { resolve = yes; reject = no; });
      // Rejections remain observable to the caller without an unhandled-rejection window.
      void settled.catch(() => undefined);
      let unsubscribe = () => {};
      let unsubscribeStatus = () => {};
      release = () => {
        unsubscribe();
        unsubscribeStatus();
        options.signal?.removeEventListener('abort', cancel);
        this.busy = false;
      };
      const cancel = () => {
        completion.abort(new Error('MEMORY_TURN_CANCELLED'));
        if (finished) return;
        finished = true;
        resolve('not-completed');
        release?.();
      };
      const finish = async () => {
        if (!accepted || !terminal || finished) return;
        finished = true;
        const completionTimeout = setTimeout(() => completion.abort(new Error('MEMORY_TURN_COMPLETION_TIMEOUT')),
          this.deps.completionTimeoutMs ?? 1500);
        try {
          const data = terminal.data as { result?: unknown; status?: string; is_error?: boolean } | undefined;
          if (terminal.type !== 'done' || data?.is_error || options.signal?.aborted
            || ['failed', 'cancelled', 'interrupted'].includes(data?.status ?? '')
            || typeof data?.result !== 'string' || !data.result.trim()) {
            resolve('not-completed');
          } else {
            this.deps.assertCurrent();
            const replyHash = digest(data.result);
            await bounded(() => this.deps.receipts.commitOnce({
              version: 1, scope: this.deps.scope, requestId, inputHash,
              replyHash, memoryFiles: recalled.map(hit => hit.file), ...(inherited ? { recovery: inherited.recovery } : {}),
            }, completion.signal), completion.signal);
            resolve('committed');
          }
        } catch (error) { reject(error); }
        finally { clearTimeout(completionTimeout); release?.(); }
      };
      const observeTerminal = (event: AgentEvent) => {
        if (generation === undefined || event.sessionTurnGeneration !== generation
          || event.turnScope === 'background') return;
        // Claimed SDK boundaries are not product completion; wait for the unclaimed final event.
        if (event.turnContinuationId !== undefined) return;
        if (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) return;
        terminal ??= event;
        void finish();
      };
      if (!this.deps.hostTerminals) unsubscribe = session.onEvent(observeTerminal);
      unsubscribeStatus = session.onStatusChange(status => { if (status !== 'active') cancel(); });
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      return { settled, cancel, terminal: observeTerminal,
        logicalRequestId: inherited?.recovery.logicalRequestId ?? requestId,
        userSource: this.prepared.userSource ? structuredClone(this.prepared.userSource) : undefined,
        augment: sendOptions => ({ ...sendOptions,
          [HOST_TURN_CONTEXT]: { requestId, text: JSON.stringify({ memories: recalled, ...(contribution ? { hostContribution: contribution } : {}) }) },
          onTurnReserved: value => { generation = value; sendOptions.onTurnReserved?.(value); },
          onDispatching: () => {
            completion.signal.throwIfAborted(); this.deps.assertCurrent(); options.assertRecoveryCurrent?.(); sendOptions.onDispatching?.();
          },
        }),
        accepted: dispatch => { accepted = dispatch.accepted; if (!accepted) cancel(); else void finish(); },
      };
    } catch (error) {
      release?.();
      this.busy = false;
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortPreparation);
    }
  }

  /** Convenience wrapper; Desktop uses prepare/augment/accepted with its own UserMessage. */
  async send(session: Pick<Session, 'send' | 'onEvent' | 'onStatusChange'>,
    requestId: string, message: string, options: SessionSendOptions = {}): Promise<MemoryTurnDispatch> {
    if (options.signal?.aborted) return { kind: 'dispatched', dispatch: { accepted: false, reason: 'cancelled-before-dispatch' },
      settled: Promise.resolve('not-completed') };
    const turn = await this.prepare(session, requestId, { identity: message, query: message }, options);
    if ('kind' in turn) return turn;
    try {
      const dispatch = await session.send(message, turn.augment(options));
      turn.accepted(dispatch);
      return { kind: 'dispatched', dispatch, settled: turn.settled };
    } catch (error) { turn.cancel(); throw error; }
  }
}
