/**
 * Test value: createFactMemory + ordinary Store editor methods; completed-only facts,
 * correction precedence, forgetting and restart uncertainty (user's A2 acceptance contract).
 * Existing storage concurrency tests have no asynchronous fact extraction queue.
 * Minimal failure: an analysis result arrives after the owner deleted its source fact.
 * Tier: unit, explicit model fixtures + real temporary file/SQLite store, no network or user data.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakerMemoryStore } from './store.js';
import { buildBotMemoryScopeKey } from './storage.js';
import { FactJournal } from './fact-journal.js';
import type { FactMemoryQueue, FactSource } from './fact-memory.js';
import type { Logger } from '../interfaces/logger.js';

const scope = { ownerId: 'fixture-owner', botId: 'fixture-bot' };
const route = { providerId: 'fixture-provider', model: 'fixture-model', protocol: 'openai-responses' as const, baseUrl: 'http://127.0.0.1:1/v1' };
const source: FactSource = { sessionId: 'fixture-session', logicalTurnId: 'fixture-turn', userMessageId: 'fixture-message', generation: 1, userText: '我喜欢青柠，不喜欢石榴。', origin: 'user' };
const add = { action: 'ADD', name: 'fruit', title: '水果偏好', description: '喜欢青柠', body: '用户喜欢青柠。', quote: '我喜欢青柠', subject: 'user' };
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
let dir: string, db: Database.Database, store: MakerMemoryStore, queue: FactMemoryQueue;
let current: boolean;
let analyze: ReturnType<typeof vi.fn>;
const assertCurrentScope = () => { if (!current) throw new Error('owner switched'); };
async function bind() {
  store = new MakerMemoryStore({ storageDir: path.join(dir, 'memory'), absWorkdir: buildBotMemoryScopeKey(scope.botId), db, logger, scopeCheck: assertCurrentScope });
  queue = await store.createFactMemory({ scope, selectedRoute: route, port: { route, analyze }, assertCurrentScope });
}
function complete(s = source) { queue.finish(queue.prepare(s), 'completed', s.generation); }
function laterSource(): FactSource { return { ...source, logicalTurnId: 'next-turn', userMessageId: 'next-message', generation: 2 }; }
async function added() { complete(); await queue.drain(); return (await store.list()).find(record => record.frontmatter.type === 'user')!; }
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-fact-memory-'));
  db = new Database(path.join(dir, 'fts.db'));
  current = true;
  analyze = vi.fn(async () => ({ route, changes: [add] }));
  await bind();
});
afterEach(async () => { queue.dispose(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });

describe('opt-in fact memory, fixture analysis only', () => {
  it('ignores failed/cancelled outcomes, rejects stale/foreign tokens and deduplicates logical retries', async () => {
    for (const outcome of ['failed', 'cancelled'] as const) queue.finish(queue.prepare(source), outcome, 1);
    expect(queue.inspect()).toEqual([]);
    const token = queue.prepare(source);
    expect(() => queue.finish(token, 'completed', 2)).toThrow('stale');
    expect(() => queue.finish({ generation: 1 }, 'completed', 1)).toThrow('Unknown');
    queue.finish(token, 'completed', 1);
    complete({ ...source, generation: 2 });
    await queue.drain();
    expect(analyze).toHaveBeenCalledTimes(1);
    const records = (await store.list()).filter(record => record.frontmatter.type === 'user');
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toContain('"messageId":"fixture-message"');
    expect((await store.search('青柠')).some(hit => hit.filename === 'digest_fact_summary.md')).toBe(true);
    expect(() => queue.prepare({ ...source, userText: 'tampered' })).toThrow('Logical source changed');
  });

  it.each([
    [{ ...add, subject: 'persona' }], [{ ...add, quote: '助手虚构的生活' }],
    [{ action: 'DELETE', filename: 'user_manual.md', subject: 'user', quote: '我喜欢青柠' }],
  ])('rejects ungrounded or unmanaged model changes: %j', async (change) => {
    analyze.mockResolvedValue({ route, changes: [change] });
    complete(); await queue.drain();
    expect(await store.list()).toEqual([]);
    expect(queue.inspect()[0]!.status).toBe('review');
  });

  it('uses ordinary editor correction to invalidate pending analysis and old logical retries', async () => {
    const record = await added();
    let resolve!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    analyze.mockImplementation(() => { entered(); return new Promise(r => { resolve = r; }); });
    complete(laterSource()); const drain = queue.drain(); await started;
    await store.update(record.filename, record.frontmatter.updatedAt, { title: '主人纠正', description: '喜欢梨', body: '用户喜欢梨。' });
    const { name: _, ...update } = add;
    resolve({ route, changes: [{ ...update, action: 'UPDATE', filename: record.filename }] });
    await drain;
    expect((await store.read(record.filename)).body).toBe('用户喜欢梨。');
    expect(queue.inspect().at(-1)?.status).toBe('conflict');
    const before = analyze.mock.calls.length;
    complete({ ...laterSource(), generation: 3 }); await queue.drain();
    expect(analyze).toHaveBeenCalledTimes(before);
  });

  it('forgets attributable summaries through the existing API but retains manual digest and blocks old sources', async () => {
    const record = await added();
    await store.write({ type: 'digest', name: 'old', title: '旧摘要', description: '青柠', body: '用户喜欢青柠。' });
    const token = queue.prepare(laterSource());
    await store.delete(record.filename, record.frontmatter.updatedAt);
    queue.finish(token, 'completed', 2);
    complete({ ...source, generation: 3 }); await queue.drain();
    expect((await store.list()).map(record => record.filename)).toEqual(['digest_old.md']);
    expect((await store.search('青柠')).map(hit => hit.filename)).toEqual(['digest_old.md']);
    expect(await store.getIndex()).not.toContain('水果偏好');
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('applies UPDATE/DELETE with original message provenance and scrubs completed queue payloads', async () => {
    const first = await added();
    const { name: _, ...update } = add;
    analyze.mockResolvedValue({ route, changes: [{ ...update, action: 'UPDATE', filename: first.filename, body: '用户现在偏爱青柠。' }] });
    complete(laterSource()); await queue.drain();
    expect((await store.read(first.filename)).body).toContain('"turnId":"next-turn"');
    analyze.mockResolvedValue({ route, changes: [{ action: 'DELETE', filename: first.filename, quote: '我喜欢青柠', subject: 'user' }] });
    complete({ ...source, logicalTurnId: 'forget-turn', userMessageId: 'forget-message', generation: 3 }); await queue.drain();
    expect(await store.list()).toEqual([]);
    expect(db.prepare('SELECT payload FROM memory_fact_jobs WHERE payload IS NOT NULL').all()).toEqual([]);
  });

  it('reopens pending jobs but never replays ambiguous analyzing/applying jobs', async () => {
    complete(); queue.dispose();
    await bind(); await queue.drain();
    expect(analyze).toHaveBeenCalledTimes(1);
    complete(laterSource());
    db.prepare("UPDATE memory_fact_jobs SET status='analyzing' WHERE status='pending'").run();
    queue.dispose(); await bind(); await queue.drain();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(queue.inspect().at(-1)).toMatchObject({ status: 'review', detail: 'interrupted' });
    expect(() => FactJournal.open(db, JSON.stringify(['other-owner', scope.botId]))).toThrow('scope mismatch');
  });

  it('NOOP keeps other queued completed turns eligible and creates no facts', async () => {
    analyze.mockResolvedValue({ route, changes: [{ action: 'NOOP' }] });
    complete(); complete(laterSource()); await queue.drain();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(queue.inspect().map(j => j.status)).toEqual(['done', 'done']);
    expect(await store.list()).toEqual([]);
  });

  it('disposal aborts an in-flight analysis and discards its late result', async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    analyze.mockImplementation(() => { entered(); return new Promise(r => { release = r; }); });
    complete(); const drain = queue.drain(); await started;
    const signal = analyze.mock.calls[0]![0].signal as AbortSignal;
    queue.dispose(); expect(signal.aborted).toBe(true);
    release({ route, changes: [add] }); await drain;
    expect(await store.list()).toEqual([]);
  });

  it('does not silently reroute persisted jobs after the selected model changes', async () => {
    complete(); queue.dispose();
    const nextRoute = { ...route, model: 'fixture-new-selection' };
    store = new MakerMemoryStore({ storageDir: path.join(dir, 'memory'), absWorkdir: buildBotMemoryScopeKey(scope.botId), db, logger, scopeCheck: assertCurrentScope });
    queue = await store.createFactMemory({ scope, selectedRoute: nextRoute, port: { route: nextRoute, analyze }, assertCurrentScope });
    await queue.drain();
    expect(analyze).not.toHaveBeenCalled();
    expect(queue.inspect()[0]!.status).toBe('conflict');
  });

  it('rejects a late result after a replacement store has recovered an ambiguous job', async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    analyze.mockImplementation(() => { entered(); return new Promise(r => { release = r; }); });
    complete(); const oldQueue = queue; const drain = queue.drain(); await started;
    await bind();
    release({ route, changes: [add] }); await drain; oldQueue.dispose();
    expect(await store.list()).toEqual([]);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary digest reset semantics after opt-in', async () => {
    for (const name of ['one', 'two']) await store.write({ type: 'digest', name, title: name, description: name, body: name });
    expect(await store.resetType('digest')).toEqual({ removedCount: 2 });
    expect(await store.list()).toEqual([]);
  });

  it('rejects stale/forged derivations and preserves manual replacements of derived files', async () => {
    const fact = await added();
    const proof = await store.captureDerivation([fact.filename]);
    await store.update(fact.filename, fact.frontmatter.updatedAt, { title: 'corrected', description: 'corrected', body: '梨' });
    await expect(store.writeDerivedMemory(proof, { type: 'digest', name: 'stale', title: 'old', description: 'old', body: '青柠' })).rejects.toMatchObject({ code: 'version-conflict' });
    await expect(store.writeDerivedMemory({}, { type: 'digest', name: 'forged', title: 'old', description: 'old', body: '青柠' })).rejects.toThrow('Invalid derivation');
    const fresh = await store.captureDerivation([fact.filename]);
    await store.writeDerivedMemory(fresh, { type: 'digest', name: 'attributed', title: 'derived', description: 'derived', body: '梨' });
    await store.write({ type: 'digest', name: 'attributed', mode: 'update', title: 'Manual', description: 'Manual', body: 'independent manual note' });
    await store.delete(fact.filename);
    expect((await store.read('digest_attributed.md')).body).toBe('independent manual note');
  });

  it('invalidates transitive summaries and rejects old derived-body reinjection after restart', async () => {
    const fact = await added();
    const proof = await store.captureDerivation(['digest_fact_summary.md']);
    await store.writeDerivedMemory(proof, { type: 'digest', name: 'child', title: 'child', description: 'child', body: 'child old fact' });
    const old = await store.read('digest_fact_summary.md');
    await store.delete(fact.filename);
    expect(await store.list()).toEqual([]);
    queue.dispose(); await bind();
    await store.write({ type: 'digest', name: 'fact_summary', title: old.frontmatter.title, description: old.frontmatter.description, body: old.body });
    expect(await store.list()).toEqual([]);
    expect(await store.search('青柠')).toEqual([]);
  });

  it('retains old summary barriers after a newer summary occupies the same filename', async () => {
    const fact = await added(); const old = await store.read('digest_fact_summary.md');
    await store.update(fact.filename, fact.frontmatter.updatedAt, { title: 'corrected', description: '梨', body: '用户喜欢梨。' });
    const nextProof = await store.captureDerivation([fact.filename]);
    await store.writeDerivedMemory(nextProof, { type: 'digest', name: 'fact_summary', title: 'User facts', description: 'Derived user fact synopsis', body: '用户喜欢梨。' });
    expect((await store.read('digest_fact_summary.md')).body).toContain('梨');
    await store.delete(fact.filename);
    queue.dispose(); await bind();
    await store.write({ type: 'digest', name: 'fact_summary', title: old.frontmatter.title, description: old.frontmatter.description, body: old.body });
    expect(await store.search('青柠')).toEqual([]); expect(await store.list()).toEqual([]);
  });

  it('rejects actual-route mismatch and owner changes without writing facts', async () => {
    analyze.mockResolvedValue({ route: { ...route, model: 'wrong-model' }, changes: [add] });
    complete(); await queue.drain();
    expect(await store.list()).toEqual([]);
    analyze.mockImplementation(async () => { current = false; return { route, changes: [add] }; });
    complete(laterSource());
    await expect(queue.drain()).rejects.toThrow('owner switched');
    current = true;
    expect(await store.list()).toEqual([]);
  });
});
