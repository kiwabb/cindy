// Production file-store contract; unit fixtures in a disposable OS temp directory, no user data.
// New persistence boundary: duplicate completion/restart must not overwrite an accepted receipt.
// Separate file because the Session tests use in-memory dependencies; bounded filesystem IO only.
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FileMemoryTurnReceipts } from './turn-receipt-store.js';
import type { MemoryTurnReceipt } from './turn-context.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'cindy-turn-receipt-unit-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const receipt = (scope = 'unit-owner/unit-bot'): MemoryTurnReceipt => ({
  version: 1, scope, requestId: 'logical-input', inputHash: 'a'.repeat(64),
  replyHash: 'b'.repeat(64), memoryFiles: ['user_fixture.md'],
});

it('publishes one immutable receipt across concurrent writers and restart', async () => {
  const store = new FileMemoryTurnReceipts(directory, () => {});
  await Promise.all([store.commitOnce(receipt()), store.commitOnce(receipt())]);
  const reopened = new FileMemoryTurnReceipts(directory, () => {});
  await reopened.commitOnce({ ...receipt(), replyHash: 'c'.repeat(64) });
  expect(await reopened.get(receipt().scope, receipt().requestId)).toEqual(receipt());
  expect(await readdir(directory)).toHaveLength(1);
});

it('isolates identical request ids across scopes and rejects reused ids for other input', async () => {
  const store = new FileMemoryTurnReceipts(directory, () => {});
  await store.commitOnce(receipt());
  expect(await store.get('another-owner/bot', receipt().requestId)).toBeNull();
  await expect(store.commitOnce({ ...receipt(), inputHash: 'd'.repeat(64) }))
    .rejects.toThrow('MEMORY_TURN_ID_CONFLICT');
  expect(await store.get(receipt().scope, receipt().requestId)).toEqual(receipt());
});

it('refuses stale owners before any directory or receipt write', async () => {
  const store = new FileMemoryTurnReceipts(path.join(directory, 'uncreated'), () => { throw new Error('STALE_OWNER'); });
  await expect(store.commitOnce(receipt())).rejects.toThrow('STALE_OWNER');
  expect(await readdir(directory)).toEqual([]);
});

it('preserves a corrupt receipt instead of treating it as a retryable empty state', async () => {
  const store = new FileMemoryTurnReceipts(directory, () => {});
  await store.commitOnce(receipt());
  const [name] = await readdir(directory);
  await writeFile(path.join(directory, name), '{}');
  await expect(store.get(receipt().scope, receipt().requestId)).rejects.toThrow('INVALID_MEMORY_RECEIPT');
  await expect(store.commitOnce(receipt())).rejects.toThrow('INVALID_MEMORY_RECEIPT');
});

// Prepared snapshots are private test fixtures, never real partner facts.
import { FileMemoryTurnSnapshots } from './turn-snapshot-store.js';
import { MemoryTurnContext, type MemoryTurnSnapshot } from './turn-context.js';
import { HOST_TURN_CONTEXT } from '../agents/shared/host-turn-context.js';
import type { AgentEvent } from '../types/events.js';
import type { Session } from '../session.js';
import { vi } from 'vitest';
const snapshot = (): MemoryTurnSnapshot => ({ version: 1, scope: 'unit-owner/unit-bot', requestId: 'input',
  inputHash: 'a'.repeat(64), recalled: [{ file: 'unit.md', title: 'Unit', excerpt: 'first fixture' }] });

it('reopens the same prepared snapshot and retains the winner of concurrent preparation', async () => {
  const store = new FileMemoryTurnSnapshots(directory, () => {});
  const signal = new AbortController().signal;
  const first = snapshot();
  const second = { ...snapshot(), recalled: [{ file: 'other.md', title: 'Other', excerpt: 'other fixture' }] };
  const [a, b] = await Promise.all([store.prepareOnce(first, signal), store.prepareOnce(second, signal)]);
  expect(a).toEqual(b);
  expect(await new FileMemoryTurnSnapshots(directory, () => {}).get(first.scope, first.requestId)).toEqual(a);
  expect(await readdir(directory)).toHaveLength(1);
  await expect(store.prepareOnce({ ...first, inputHash: 'f'.repeat(64) }, signal)).rejects.toThrow('ID_CONFLICT');
});

it('rejects aborted snapshot publication and corrupt snapshots without treating them as missing', async () => {
  const store = new FileMemoryTurnSnapshots(directory, () => {});
  const abort = new AbortController(); abort.abort(new Error('unit cancel'));
  await expect(store.prepareOnce(snapshot(), abort.signal)).rejects.toThrow('unit cancel');
  expect(await readdir(directory)).toEqual([]);
  await store.prepareOnce(snapshot(), new AbortController().signal);
  const [name] = await readdir(directory);
  await writeFile(path.join(directory, name), '{}');
  await expect(store.get(snapshot().scope, snapshot().requestId)).rejects.toThrow('INVALID_MEMORY_SNAPSHOT');
});

it('recovers prepared context after controller restart without re-retrieval; completion dedupes the next restart', async () => {
  const events = new Set<(event: AgentEvent) => void>();
  const statuses = new Set<Parameters<Session['onStatusChange']>[0]>();
  const session = {
    onEvent: (fn: (event: AgentEvent) => void) => { events.add(fn); return () => { events.delete(fn); }; },
    onStatusChange: (fn: Parameters<Session['onStatusChange']>[0]) => { statuses.add(fn); return () => { statuses.delete(fn); }; },
  };
  const search = vi.fn(async () => [{ filename: 'unit.md', type: 'user' as const,
    title: 'Unit fixture', snippet: 'original', score: -1 }]);
  const create = () => new MemoryTurnContext({ scope: 'unit-scope', memory: { search, read: async () => ({ body: 'original' }) }, assertCurrent: () => {},
    receipts: new FileMemoryTurnReceipts(path.join(directory, 'completed'), () => {}),
    snapshots: new FileMemoryTurnSnapshots(path.join(directory, 'prepared'), () => {}),
  });
  const first = await create().prepare(session, 'stable-id', { identity: 'unit input', query: 'unit input' });
  if ('kind' in first) throw new Error('missing preparation');
  const context = first.augment({})[HOST_TURN_CONTEXT];
  first.cancel();
  search.mockResolvedValue([]);
  const resumed = await create().prepare(session, 'stable-id', { identity: 'unit input', query: 'unit input' });
  if ('kind' in resumed) throw new Error('missing recovery');
  expect(resumed.augment({})[HOST_TURN_CONTEXT]).toEqual(context);
  expect(search).toHaveBeenCalledOnce();
  resumed.augment({}).onTurnReserved?.(8);
  // An old/background done must not complete this logical input.
  for (const listener of events) listener({ type: 'done', sessionTurnGeneration: 7, data: { result: 'old' } } as AgentEvent);
  resumed.accepted({ accepted: true });
  for (const listener of events) listener({ type: 'done', sessionTurnGeneration: 8,
    turnContinuationId: 1, data: { result: 'intermediate' } } as AgentEvent);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(events.size).toBe(1);
  for (const listener of events) listener({ type: 'done', sessionTurnGeneration: 8, data: { result: 'unit result' } } as AgentEvent);
  expect(await resumed.settled).toBe('committed');
  expect(events.size).toBe(0); expect(statuses.size).toBe(0);
  expect(await create().prepare(session, 'stable-id', { identity: 'unit input', query: 'changed retrieval' }))
    .toEqual({ kind: 'already-completed' });
  expect(search).toHaveBeenCalledOnce();
});
