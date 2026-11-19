import { it, expect, vi } from 'vitest';
import { MemoryTurnContext, resolveMemoryRecovery, type MemoryTurnSnapshot } from './turn-context.js';
import { HOST_TURN_CONTEXT } from '../agents/shared/host-turn-context.js';
const scope = JSON.stringify(['unit-owner', 'unit-bot', 'unit-session']);
function fixture(hostTerminals = false, contribute?: ConstructorParameters<typeof MemoryTurnContext>[0]["contribute"]) {
  const rows = new Map<string, MemoryTurnSnapshot>();
  const snapshots = { get: vi.fn(async (s: string, id: string) => s === scope ? structuredClone(rows.get(id) ?? null) : null),
    prepareOnce: vi.fn(async (v: MemoryTurnSnapshot) => { if (!rows.has(v.requestId)) rows.set(v.requestId, structuredClone(v)); return structuredClone(rows.get(v.requestId)!); }) };
  const memory = { search: vi.fn(async () => [{ filename: 'unit.md', title: 'unit', snippet: '', score: 1, type: 'reference' as const }]), read: vi.fn(async () => ({ body: 'frozen fact' })) };
  const committed: any[] = [];
  const controller = new MemoryTurnContext({ scope, snapshots, memory, hostTerminals, contribute, receipts: { get: async () => null, commitOnce: async r => { committed.push(structuredClone(r)); } }, assertCurrent() {} });
  let listener: (event: any) => void = () => {};
  const session = { onEvent: (cb: typeof listener) => { listener = cb; return () => {}; }, onStatusChange: () => () => {} };
  return { rows, snapshots, memory, controller, session, committed, emit: (event: any) => listener(event) };
}
async function prepare(f: ReturnType<typeof fixture>, id: string, from?: string, guard = () => {}) {
  const turn = await f.controller.prepare(f.session, id, { identity: id, query: from ? '' : 'unit', inheritFrom: from }, { assertRecoveryCurrent: guard });
  if ('kind' in turn) throw Error('unexpected dedupe'); return turn;
}
it('inherits frozen original across two retries without rereading memory or rewriting root', async () => {
  const f = fixture(); (await prepare(f, 'a')).cancel(); const before = JSON.stringify(f.rows.get('a'));
  (await prepare(f, 'b', 'a')).cancel(); const c = await prepare(f, 'c', 'b');
  expect(c.augment({})[HOST_TURN_CONTEXT]?.text).toContain('frozen fact');
  expect(f.rows.get('c')?.recovery).toEqual({ sourceRequestId: 'b', logicalRequestId: 'a', logicalInputHash: f.rows.get('a')!.inputHash });
  expect(f.rows.get('c')!.inputHash).not.toBe(f.rows.get('a')!.inputHash);
  expect(JSON.stringify(f.rows.get('a'))).toBe(before); expect(f.memory.search).toHaveBeenCalledTimes(1); expect(f.memory.read).toHaveBeenCalledTimes(1); c.cancel();
  await expect(f.controller.prepare(f.session, 'c', { identity: 'tampered', query: '', inheritFrom: 'b' }, { assertRecoveryCurrent() {} })).rejects.toThrow('ID_CONFLICT');
});
it('rejects missing/cross-scope sources, cycles and changed lineage hashes or recalled facts', async () => {
  const f = fixture(); (await prepare(f, 'a')).cancel();
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'b', 'missing', () => {})).rejects.toThrow('SOURCE_MISSING');
  await expect(resolveMemoryRecovery(f.snapshots, 'foreign', 'b', 'a', () => {})).rejects.toThrow('SOURCE_MISSING');
  await expect(resolveMemoryRecovery({ ...f.snapshots, get: async () => ({ ...f.rows.get('a')!, scope: 'foreign' }) }, scope, 'b', 'a', () => {})).rejects.toThrow('SCOPE_CHANGED');
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'a', 'a', () => {})).rejects.toThrow('CYCLE');
  (await prepare(f, 'b', 'a')).cancel();
  f.rows.get('b')!.recovery!.logicalInputHash = '0'.repeat(64);
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'c', 'b', () => {})).rejects.toThrow('LINEAGE_CHANGED');
  f.rows.get('b')!.recovery!.logicalInputHash = f.rows.get('a')!.inputHash; f.rows.get('b')!.recalled[0].excerpt = 'changed';
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'c', 'b', () => {})).rejects.toThrow('LINEAGE_CHANGED');
  f.rows.get('b')!.recovery!.sourceRequestId = 'b';
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'c', 'b', () => {})).rejects.toThrow('CYCLE');
});
it('rechecks generation after snapshot IO and before dispatch', async () => {
  const f = fixture(); (await prepare(f, 'a')).cancel(); let live = true; const guard = () => { if (!live) throw Error('stale'); };
  const get = f.snapshots.get; f.snapshots.get = vi.fn(async (...a: Parameters<typeof get>) => { const r = await get(...a); live = false; return r; });
  await expect(prepare(f, 'b', 'a', guard)).rejects.toThrow('stale'); f.snapshots.get = get; live = true;
  const c = await prepare(f, 'c', 'a', guard); live = false; expect(() => c.augment({}).onDispatching?.()).toThrow('stale'); c.cancel();
});
it('never retrofits existing empty snapshots and requires a Main guard for inheritance', async () => {
  const f = fixture(); (await prepare(f, 'a')).cancel(); (await prepare(f, 'b')).cancel(); const before = JSON.stringify(f.rows.get('b'));
  await expect(prepare(f, 'b', 'a')).rejects.toThrow('LINEAGE_CHANGED'); expect(JSON.stringify(f.rows.get('b'))).toBe(before);
  await expect(f.controller.prepare(f.session, 'c', { identity: 'c', query: '', inheritFrom: 'a' })).rejects.toThrow('PROOF_REQUIRED');
});

it('records a successful recovery attempt with logical lineage, ignores old generation and rejects unlinked legacy continues', async () => {
  const f = fixture(); (await prepare(f, 'original')).cancel();
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'new', 'original', () => {}, true)).rejects.toThrow('SOURCE_UNLINKED');
  const root = JSON.stringify(f.rows.get('original'));
  const turn = await prepare(f, 'retry', 'original');
  turn.augment({}).onTurnReserved?.(12); turn.accepted({ accepted: true });
  f.emit({ type: 'done', sessionTurnGeneration: 11, data: { result: 'old fixture reply' } });
  expect(f.committed).toHaveLength(0);
  f.emit({ type: 'done', sessionTurnGeneration: 12, data: { result: 'fixture final', status: 'completed' } });
  expect(await turn.settled).toBe('committed');
  expect(f.committed).toHaveLength(1);
  expect(f.committed[0]).toMatchObject({ requestId: 'retry', recovery: { sourceRequestId: 'original', logicalRequestId: 'original' }, memoryFiles: ['unit.md'] });
  expect(JSON.stringify(f.rows.get('original'))).toBe(root);
});
it('keeps existing disk snapshots and completed receipts byte-identical when adding or conflicting with lineage', async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const { FileMemoryTurnSnapshots } = await import('./turn-snapshot-store.js');
  const { FileMemoryTurnReceipts } = await import('./turn-receipt-store.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-memory-recovery-unit-'));
  try {
    const snapshots = new FileMemoryTurnSnapshots(path.join(dir, 'prepared'), () => {});
    const receipts = new FileMemoryTurnReceipts(path.join(dir, 'completed'), () => {});
    const root: MemoryTurnSnapshot = { version: 1, scope, requestId: 'root', inputHash: 'a'.repeat(64), recalled: [{ file: 'unit.md', title: 'fixture', excerpt: 'frozen' }] };
    const signal = new AbortController().signal;
    await snapshots.prepareOnce(root, signal);
    await receipts.commitOnce({ version: 1, scope, requestId: 'root', inputHash: root.inputHash, replyHash: 'b'.repeat(64), memoryFiles: ['unit.md'] });
    const rootFile = path.join(dir, 'prepared', (await readdir(path.join(dir, 'prepared')))[0]);
    const receiptFile = path.join(dir, 'completed', (await readdir(path.join(dir, 'completed')))[0]);
    const before = [await readFile(rootFile, 'utf8'), await readFile(receiptFile, 'utf8')];
    const inherited = await resolveMemoryRecovery(snapshots, scope, 'retry', 'root', () => {});
    await snapshots.prepareOnce({ ...root, requestId: 'retry', inputHash: 'c'.repeat(64), ...inherited }, signal);
    await expect(snapshots.prepareOnce({ ...root, recovery: inherited.recovery }, signal)).rejects.toThrow('ID_CONFLICT');
    await receipts.commitOnce({ version: 1, scope, requestId: 'root', inputHash: root.inputHash, replyHash: 'd'.repeat(64), memoryFiles: [] });
    expect([await readFile(rootFile, 'utf8'), await readFile(receiptFile, 'utf8')]).toEqual(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Fixtures only: Main product classifier is exercised through its explicit terminal seam.
it('waits for host final terminal and carries the original user source through consecutive retries', async () => {
  const f = fixture(true);
  const root = await f.controller.prepare(f.session, 'source', { identity: 'source', query: 'unit', userSource: { messageId: 'human-id', text: 'human fixture text' } });
  if ('kind' in root) throw Error('unexpected'); root.cancel();
  (await prepare(f, 'continue', 'source')).cancel();
  const retry = await prepare(f, 'retry-again', 'continue');
  expect(retry.logicalRequestId).toBe('source');
  expect(retry.userSource).toEqual({ messageId: 'human-id', text: 'human fixture text' });
  retry.augment({}).onTurnReserved?.(21); retry.accepted({ accepted: true });
  f.emit({ type: 'done', sessionTurnGeneration: 21, data: { result: 'SDK boundary fixture' } });
  expect(f.committed).toHaveLength(0);
  retry.terminal({ type: 'done', sessionTurnGeneration: 20, data: { result: 'stale fixture' } } as any);
  expect(f.committed).toHaveLength(0);
  retry.terminal({ type: 'done', sessionTurnGeneration: 21, data: { result: 'classified final fixture' } } as any);
  expect(await retry.settled).toBe('committed'); expect(f.committed).toHaveLength(1);
  f.rows.get('continue')!.userSource!.text = 'tampered human';
  await expect(resolveMemoryRecovery(f.snapshots, scope, 'foreign-source', 'continue', () => {})).rejects.toThrow('LINEAGE_CHANGED');
});
it('host cancellation cannot become a completion receipt', async () => {
  const f = fixture(true); const turn = await prepare(f, 'cancelled');
  turn.augment({}).onTurnReserved?.(3); turn.accepted({ accepted: true }); turn.cancel();
  turn.terminal({ type: 'done', sessionTurnGeneration: 3, data: { result: 'late fixture' } } as any);
  expect(await turn.settled).toBe('not-completed'); expect(f.committed).toHaveLength(0);
});

// Companion contribution patch: root capture/recovery observable through production prepare/augment.
// New optional host port is not covered by existing memory-only recovery tests. Unit, no model/IO.
it('freezes host contribution once across retries and restart without refreshing live state', async () => {
  const contribution = { revision: 7, text: 'fictional fixture state', sourceRefs: ['plan:fixture'] };
  const contribute = vi.fn(async () => contribution);
  const f = fixture(true, contribute);
  const root = await prepare(f, 'contribution-root');
  const before = JSON.stringify(f.rows.get('contribution-root')); root.cancel();
  contribution.revision = 8; contribution.text = 'changed live state';
  const restarted = fixture(true, contribute);
  for (const [id, row] of f.rows) restarted.rows.set(id, structuredClone(row));
  const retry = await prepare(restarted, 'contribution-retry', 'contribution-root');
  expect(JSON.parse(retry.augment({})[HOST_TURN_CONTEXT]!.text).hostContribution)
    .toEqual({ revision: 7, text: 'fictional fixture state', sourceRefs: ['plan:fixture'] });
  expect(contribute).toHaveBeenCalledTimes(1); retry.cancel();
  expect(JSON.stringify(restarted.rows.get('contribution-root'))).toBe(before);
  restarted.rows.get('contribution-retry')!.contribution = { revision: 7, text: 'tampered', sourceRefs: ['plan:fixture'] };
  await expect(prepare(restarted, 'contribution-retry', 'contribution-root')).rejects.toThrow('LINEAGE_CHANGED');
  await expect(resolveMemoryRecovery(restarted.snapshots, scope, 'third', 'contribution-retry', () => {})).rejects.toThrow('LINEAGE_CHANGED');
});
it('does not add a new contribution to legacy snapshots on recovery or repeated prepare', async () => {
  const legacy = fixture(); (await prepare(legacy, 'legacy-root')).cancel();
  const contribute = vi.fn(async () => ({ revision: 1, text: 'new state', sourceRefs: [] }));
  const current = fixture(true, contribute);
  for (const [id, row] of legacy.rows) current.rows.set(id, structuredClone(row));
  (await prepare(current, 'legacy-root')).cancel();
  const retry = await prepare(current, 'legacy-retry', 'legacy-root');
  expect(JSON.parse(retry.augment({})[HOST_TURN_CONTEXT]!.text).hostContribution).toBeUndefined();
  expect(contribute).not.toHaveBeenCalled(); retry.cancel();
});
it('rejects oversized contribution before snapshot persistence and aborts a pending capture', async () => {
  const oversized = fixture(true, async () => ({ revision: 1, text: 'x'.repeat(4097), sourceRefs: [] }));
  await expect(prepare(oversized, 'oversized')).rejects.toThrow('INVALID_MEMORY_TURN_CONTRIBUTION');
  expect(oversized.rows.size).toBe(0);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = fixture(true, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { revision: 1, text: 'late', sourceRefs: [] }; });
  const abort = new AbortController();
  const work = waiting.controller.prepare(waiting.session, 'cancel-capture', { identity: 'cancel-capture', query: 'fixture' }, { signal: abort.signal });
  await started; abort.abort(new Error('CANCELLED_FIXTURE')); release();
  await expect(work).rejects.toThrow('CANCELLED_FIXTURE'); expect(waiting.rows.size).toBe(0);
});
