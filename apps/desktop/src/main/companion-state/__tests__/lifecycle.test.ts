/**
 * Production entry: file store, completed-turn runtime, native bridge and proactive controller.
 * Contract: owner/bot privacy, no negative-affect penalty, no duplicate or post-cancel delivery.
 * Gap: these opt-in modules are new; existing fact-memory/scheduler tests do not cover their ledger.
 * Minimal failures: duplicate completion, two concurrent claims, restart after an unknown send.
 * Tier: unit, no model/network; real temporary files, injected serialized lock and delivery fixtures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStore, type TransactionLock } from '../store.js';
import { initialState, type Affect, type Binding, type CompletedTurn } from '../types.js';
import { applyAffect, affectAt } from '../affect.js';
import { savePlan, duePlans, settlePlans, localClock, planEventId } from '../planning.js';
import { ProactiveController, eligibility, type Delivery, type Presence } from '../proactive.js';
import { contributeCompanionContext } from '../context.js';
import { generateFictionPlan } from '../generation.js';
import { CompanionStateRuntime } from '../runtime.js';
import { bindCompanionStateTurns, withCompanionStateTurn, finishCompanionStateTurn } from '../nativeTurns.js';
import { bindCompanionSchedule, withCompanionSchedules } from '../scheduler.js';

const binding: Binding = { ownerId: 'owner-fixture', botId: 'bot-fixture', sessionId: 'session-fixture', ownerEpoch: '1', instanceId: 'instance-1', deviceId: 'device-fixture' };
const now = Date.parse('2026-11-17T12:00:00Z');
const turn: CompletedTurn = { ...binding, logicalTurnId: 'turn-1', generation: 1, completedAt: now, status: 'completed', source: 'owner-private', userMessageId: 'user-1', assistantMessageId: 'assistant-1' };
const sad: Affect = { valence: 'negative', intensity: 1, relationship: 'none' };
const roots: string[] = [];
const locks = new Map<string, Promise<unknown>>();
const lock: TransactionLock = async (file, run) => {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run); locks.set(file, next);
  try { return await next; } finally { if (locks.get(file) === next) locks.delete(file); }
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-companion-unit-'))); roots.push(root);
  let active = true;
  const current = () => { if (!active) throw new Error('STALE_OWNER'); };
  const store = createStateStore(root, binding, current, lock);
  return { root, store, current, deactivate: () => { active = false; } };
}
async function proactive() {
  const base = await setup();
  await base.store.update(0, state => { state.policy = { enabled: true, timezone: 'UTC', cooldownMs: 0, dailyBudget: 2 }; });
  const presence: Presence = { executor: true, unread: false, lastInteractionAt: now - 3600_000, refused: false };
  const delivered = new Map<string, string>();
  const delivery: Delivery = {
    send: vi.fn<Delivery['send']>(async item => { delivered.set(item.id, 'receipt-1'); return { status: 'delivered', messageId: 'receipt-1' }; }),
    lookup: vi.fn<Delivery['lookup']>(async item => delivered.has(item.id) ? { status: 'delivered', messageId: delivered.get(item.id)! } : { status: 'unknown' }),
  };
  const make = () => new ProactiveController(base.store, binding, async () => presence, delivery, base.current, () => now);
  return { ...base, presence, delivery, delivered, make, controller: make() };
}
describe('private companion lifecycle', () => {
  it('keeps sadness separate from trust, decays intensity and deduplicates stable turns', async () => {
    const { store, current } = await setup();
    expect(await applyAffect(store, binding, turn, sad, 0, current)).toBe('applied');
    const saved = await store.read();
    expect(saved.affect.trust).toBe(0);
    expect(affectAt(saved, now + 86400_000).intensity).toBe(0.5);
    expect(await applyAffect(store, binding, { ...turn, assistantMessageId: 'retry-assistant' }, sad, saved.revision, current)).toBe('duplicate');
    expect(Object.keys((await store.read()).turns)).toHaveLength(1);
  });
  it('rejects cross-owner/late generation and lets only one CAS mutation win', async () => {
    const { store, current } = await setup();
    await expect(applyAffect(store, binding, { ...turn, ownerId: 'other' }, sad, 0, current)).rejects.toThrow('STALE_TURN');
    await expect(applyAffect(store, binding, { ...turn, instanceId: 'old' }, sad, 0, current)).rejects.toThrow('STALE_TURN');
    const results = await Promise.allSettled([applyAffect(store, binding, turn, sad, 0, current), applyAffect(store, binding, turn, sad, 0, current)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.read()).revision).toBe(1);
  });
  it('deduplicates logical turns across attempts and sessions, rejecting altered root provenance', async () => {
    const { store, current } = await setup();
    await applyAffect(store, binding, turn, { ...sad, relationship: 'respect' }, 0, current);
    const recovered = { ...binding, sessionId: 'recovered-session', instanceId: 'new-instance', ownerEpoch: '2' };
    const retry = { ...turn, ...recovered, generation: 42, assistantMessageId: 'new-assistant' };
    expect(await applyAffect(store, recovered, retry, sad, 1, current)).toBe('duplicate');
    expect((await store.read()).affect.trust).toBe(0.01);
    await expect(applyAffect(store, recovered, { ...retry, userMessageId: 'altered-root' }, sad, 2, current)).rejects.toThrow('LOGICAL_TURN_CONFLICT');
    await expect(applyAffect(store, binding, { ...turn, ownerEpoch: 'stale' }, sad, 2, current)).rejects.toThrow('STALE_TURN');
    await expect(applyAffect(store, binding, { ...turn, generation: -1 }, sad, 2, current)).rejects.toThrow('INVALID_TURN_GENERATION');
  });
  it('projects bounded frozen context with provenance, without rereading changed state', async () => {
    const { store, current } = await setup();
    await applyAffect(store, binding, turn, sad, 0, current);
    const frozen = structuredClone(await store.read());
    const args = { scope: binding, snapshot: frozen, capturedAt: now, assertCurrent: current, signal: new AbortController().signal };
    const original = contributeCompanionContext(args);
    expect(original.sourceRefs).toHaveLength(1); expect(original.sourceRefs[0]).toMatch(/^turn:/);
    expect(JSON.parse(original.text).affect.intensity).toBe(1);
    await store.update(undefined, state => { state.affect.intensity = 0; });
    expect(contributeCompanionContext(args)).toEqual(original);
    expect(contributeCompanionContext({ ...args, maxChars: 1 })).toEqual({ revision: frozen.revision, text: '', sourceRefs: [] });
    expect(Object.isFrozen(original)).toBe(true); expect(Object.isFrozen(original.sourceRefs)).toBe(true);
    expect(() => contributeCompanionContext({ ...args, scope: { ...binding, botId: 'other' } })).toThrow('SCOPE_MISMATCH');
    const abort = new AbortController(); abort.abort();
    expect(() => contributeCompanionContext({ ...args, signal: abort.signal })).toThrow();
  });
  it('preserves newer affect when an older analysis arrives', async () => {
    const { store, current } = await setup();
    await applyAffect(store, binding, turn, sad, 0, current);
    expect(await applyAffect(store, binding, { ...turn, logicalTurnId: 'old', completedAt: now - 1 },
      { ...sad, relationship: 'respect' }, 1, current)).toBe('outdated');
    expect((await store.read()).affect.trust).toBe(0);
  });
  it('separates owner/bot files and preserves damaged ledgers instead of resetting budget', async () => {
    const { root, store, current } = await setup();
    await store.update(0, state => { state.refused = true; });
    const other = createStateStore(root, { ...binding, botId: 'other' }, current, lock);
    expect((await other.read()).refused).toBe(false);
    const file = path.join(root, 'companion-state', (await fs.readdir(path.join(root, 'companion-state')))[0]);
    await fs.writeFile(file, '{broken');
    await expect(store.update(undefined, state => { state.refused = false; })).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });
  it('requires owner provenance for real plans and expires/completes without resurrecting dates', async () => {
    const { store } = await setup();
    const plan = { id: 'wish-1', kind: 'wish' as const, domain: 'owner-commitment' as const, title: 'fixture commitment', date: '2026-11-17', timezone: 'Asia/Shanghai', expiresAt: now + 1000, status: 'pending' as const, ownerMessageId: 'owner-message' };
    await expect(savePlan(store, plan, now, 0)).rejects.toThrow('OWNER_EVIDENCE');
    await savePlan(store, plan, now, 0, 'owner-message');
    expect(duePlans(Object.values((await store.read()).plans), now)).toHaveLength(1);
    await settlePlans(store, now, plan.id);
    expect(duePlans(Object.values((await store.read()).plans), now)).toHaveLength(0);
    const fictional = { ...plan, id: 'fiction', domain: 'character-fiction' as const, ownerMessageId: undefined };
    await savePlan(store, fictional, now, (await store.read()).revision);
    await settlePlans(store, now + 1000);
    expect((await store.read()).plans.fiction.status).toBe('expired');
    expect(localClock(Date.parse('2026-11-17T23:30:00Z'), 'Asia/Shanghai').day).toBe('2026-11-18');
    await expect(savePlan(store, { ...fictional, date: '2026-02-30' }, now, 0)).rejects.toThrow();
  });
  it.each(['unread', 'refused', 'not-executor', 'recent-interaction', 'quiet-hours', 'disabled'])('suppresses %s before delivery', reason => {
    const state = initialState(binding); state.policy.enabled = reason !== 'disabled';
    const presence = { executor: reason !== 'not-executor', unread: reason === 'unread', refused: reason === 'refused', lastInteractionAt: reason === 'recent-interaction' ? now : 0 };
    expect(eligibility(state, presence, reason === 'quiet-hours' ? Date.parse('2026-11-17T23:00:00Z') : now)).toBe(reason);
  });
  it('persists daily reservations through reopen and rejects duplicate event payloads', async () => {
    const f = await proactive();
    const first = await f.controller.enqueue('event-1', 'fixture message', now + 1000);
    expect(await f.controller.enqueue('event-1', 'fixture message', now + 1000)).toBe(first);
    await expect(f.controller.enqueue('event-1', 'changed', now + 1000)).rejects.toThrow('CONFLICT');
    const reopened = createStateStore(f.root, binding, f.current, lock);
    const restarted = new ProactiveController(reopened, binding, async () => f.presence, f.delivery, f.current, () => now);
    await restarted.enqueue('event-2', 'fixture message 2', now + 1000);
    await expect(restarted.enqueue('event-3', 'fixture message 3', now + 1000)).rejects.toThrow('daily-budget');
    expect((await reopened.read()).budgets['2026-11-17']).toBe(2);
  });
  it('two controllers claim one outbox once and recheck recent interaction before publication', async () => {
    const f = await proactive();
    const id = await f.controller.enqueue('event-1', 'fixture message', now + 1000);
    await Promise.all([f.controller.dispatch(id), f.make().dispatch(id)]);
    expect(f.delivery.send).toHaveBeenCalledTimes(1);
    expect((await f.store.read()).outbox[id].status).toBe('delivered');
    const second = await f.controller.enqueue('event-2', 'second fixture', now + 1000);
    f.presence.lastInteractionAt = now;
    expect(await f.controller.dispatch(second)).toEqual({ status: 'suppressed' });
    expect(f.delivery.send).toHaveBeenCalledTimes(1);
  });
  it('completing a dated plan cancels its already queued notification', async () => {
    const f = await proactive();
    const plan = { id: 'plan', date: '2026-11-17', timezone: 'UTC', expiresAt: now + 1000,
      kind: 'anniversary' as const, domain: 'character-fiction' as const, title: 'fixture date', status: 'pending' as const };
    await savePlan(f.store, plan, now, (await f.store.read()).revision);
    const id = await f.controller.enqueue(planEventId(plan), 'fixture', plan.expiresAt, plan.id);
    await settlePlans(f.store, now, plan.id);
    expect(await f.controller.dispatch(id)).toEqual({ status: 'suppressed' });
    expect(f.delivery.send).not.toHaveBeenCalled();
    expect((await f.store.read()).outbox[id].status).toBe('cancelled');
  });
  it('policy revocation after claim prevents send and cooldown survives midnight', async () => {
    const f = await proactive();
    const id = await f.controller.enqueue('event', 'fixture', now + 1000);
    let checks = 0;
    const controller = new ProactiveController(f.store, binding, async () => {
      checks++;
      if (checks === 2) await f.store.update(undefined, state => { state.policy.enabled = false; });
      return f.presence;
    }, f.delivery, f.current, () => now);
    expect(await controller.dispatch(id)).toEqual({ status: 'not-sent' });
    expect(f.delivery.send).not.toHaveBeenCalled();
    await f.store.update(undefined, state => { state.policy.enabled = true; state.policy.cooldownMs = 48 * 3600_000; });
    const nextDay = new ProactiveController(f.store, binding, async () => f.presence, f.delivery, f.current, () => now + 86400_000);
    await expect(nextDay.enqueue('next-day', 'fixture', now + 2 * 86400_000)).rejects.toThrow('cooldown');
  });
  it('does not resend after ambiguous failure; receipt lookup recovers across restart', async () => {
    const f = await proactive();
    f.delivery.send = vi.fn(async item => { f.delivered.set(item.id, 'late-receipt'); throw new Error('connection lost'); });
    const id = await f.controller.enqueue('event', 'fixture message', now + 1000);
    expect(await f.controller.dispatch(id)).toEqual({ status: 'unknown' });
    expect(await f.make().dispatch(id)).toEqual({ status: 'suppressed' });
    await f.make().recover();
    expect((await f.store.read()).outbox[id].receiptId).toBe('late-receipt');
    expect(f.delivery.send).toHaveBeenCalledTimes(1);
  });
  it('dispose prevents late receipt writes; recovery sees unresolved sending', async () => {
    const f = await proactive();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.delivery.send = vi.fn<Delivery['send']>(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { status: 'delivered', messageId: 'late' }; });
    const id = await f.controller.enqueue('event', 'fixture message', now + 1000);
    const sending = f.controller.dispatch(id); await started;
    f.controller.dispose(); release();
    await expect(sending).rejects.toThrow('DISPOSED');
    expect((await f.store.read()).outbox[id].status).toBe('sending');
    await f.make().recover(); expect((await f.store.read()).outbox[id].status).toBe('unknown');
  });
  it('default off and unverified completions never call analysis; disposal rejects late analysis', async () => {
    const f = await setup();
    const analysis = { analyze: vi.fn(async () => sad) };
    const options = { binding, route: { providerId: 'fixture-sub2api', model: 'gpt-6-astra', protocol: 'openai-responses' as const, baseUrl: 'http://127.0.0.1:18080/v1' }, store: f.store, assertCurrent: f.current, verify: async () => true, analysis };
    await new CompanionStateRuntime(options).complete(turn, 'fixture');
    expect(analysis.analyze).not.toHaveBeenCalled();
    await expect(new CompanionStateRuntime({ ...options, enabled: true, verify: async () => false }).complete(turn, 'fixture')).rejects.toThrow('NOT_DURABLE');
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    analysis.analyze = vi.fn(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return sad; });
    const runtime = new CompanionStateRuntime({ ...options, enabled: true });
    const work = runtime.complete(turn, 'fixture'); await started; runtime.dispose(); release();
    await expect(work).rejects.toThrow('DISPOSED');
    expect((await f.store.read()).revision).toBe(0);
  });
  it('fiction generation is default off, model-pinned and cannot write owner commitments', async () => {
    const f = await setup();
    const request = vi.fn(async () => JSON.stringify({ title: 'fictional garden walk', domain: 'owner-commitment' }));
    const args = { route: { providerId: 'fixture-sub2api', model: 'gpt-6-astra', protocol: 'openai-responses' as const, baseUrl: 'http://127.0.0.1:18080/v1' },
      characterContext: 'fictional fixture', date: '2026-11-17', timezone: 'UTC', expiresAt: now + 1000,
      id: 'fiction', now, signal: new AbortController().signal, store: f.store, assertCurrent: f.current, request };
    expect(await generateFictionPlan(args)).toBe(null); expect(request).not.toHaveBeenCalled();
    const saved = await generateFictionPlan({ ...args, enabled: true });
    expect(saved?.domain).toBe('character-fiction'); expect(saved?.ownerMessageId).toBeUndefined();
    await generateFictionPlan({ ...args, enabled: true }); expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects symlink state files and fails stale-owner writes without creating state', async () => {
    const f = await setup();
    await f.store.update(0, state => { state.refused = true; });
    const dir = path.join(f.root, 'companion-state'), file = path.join(dir, (await fs.readdir(dir))[0]);
    const target = path.join(f.root, 'original'); await fs.rename(file, target); await fs.symlink(target, file);
    await expect(f.store.read()).rejects.toThrow();
    f.deactivate(); await expect(f.store.update(undefined, () => {})).rejects.toThrow('STALE_OWNER');
  });
  it('expired or changed-generation pending messages never dispatch', async () => {
    const f = await proactive();
    const id = await f.controller.enqueue('event', 'fixture message', now + 1);
    const restarted = new ProactiveController(f.store, { ...binding, instanceId: 'new-instance' }, async () => f.presence, f.delivery, f.current, () => now + 2);
    expect(await restarted.dispatch(id)).toEqual({ status: 'suppressed' });
    expect((await f.store.read()).outbox[id].status).toBe('cancelled');
    expect(f.delivery.send).not.toHaveBeenCalled();
  });
  it('native completion requires reserved generation and unbinding rejects late vendor events', async () => {
    const session = { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null };
    const completed = vi.fn(async (_turn: CompletedTurn, _source: unknown) => {}), reportFailure = vi.fn();
    const unbind = bindCompanionStateTurns(session, { binding, assertCurrent() {}, completed, reportFailure });
    const source = { logicalTurnId: 'turn', userMessageId: 'user', userText: 'fixture', origin: 'user' as const };
    let reserve!: (generation: number) => void;
    const frozenDispatch = withCompanionStateTurn(session, source, async reserved => { reserve = reserved!; source.userText = 'mutated-after-begin'; reserve(0); return { accepted: true } as never; });
    await frozenDispatch; finishCompanionStateTurn(session, 0, 'completed', 'assistant');
    expect(completed.mock.calls[0][1]).toMatchObject({ userText: 'fixture' });
    expect(completed.mock.calls[0][0]).toMatchObject({ ownerEpoch: binding.ownerEpoch, instanceId: binding.instanceId, generation: 0, logicalTurnId: 'turn' });
    completed.mockClear();
    await withCompanionStateTurn(session, source, async reserved => { reserved?.(1); return { accepted: true } as never; });
    finishCompanionStateTurn(session, 2, 'completed', 'assistant'); expect(completed).not.toHaveBeenCalled();
    finishCompanionStateTurn(session, 1, 'failed', 'assistant'); expect(completed).not.toHaveBeenCalled();
    await withCompanionStateTurn(session, source, async reserved => { reserved?.(3); return { accepted: true } as never; });
    finishCompanionStateTurn(session, 3, 'completed', 'assistant'); expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toMatchObject({ ...binding, source: 'owner-private', status: 'completed' });
    unbind(); finishCompanionStateTurn(session, 3, 'completed', 'assistant'); expect(completed).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched instance binding and stale instance terminal events', async () => {
    const session = { id: binding.sessionId, instanceId: 'other', remoteHostId: null };
    const completed = vi.fn(async () => {}), reportFailure = vi.fn();
    expect(() => bindCompanionStateTurns(session, { binding, assertCurrent() {}, completed, reportFailure })).toThrow('BINDING_INVALID');
    session.instanceId = binding.instanceId;
    const unbind = bindCompanionStateTurns(session, { binding, assertCurrent() {}, completed, reportFailure });
    try {
      await withCompanionStateTurn(session, { logicalTurnId: 'root', userMessageId: 'user', userText: 'fixture', origin: 'user' }, async reserved => {
        reserved?.(4); return { accepted: true } as never;
      });
      session.instanceId = 'replaced';
      finishCompanionStateTurn(session, 4, 'completed', 'assistant');
      expect(completed).not.toHaveBeenCalled(); expect(reportFailure).toHaveBeenCalledOnce();
    } finally { unbind(); }
  });
  it('scheduler binding uses outbox and leaves unrelated schedules on the original runner', async () => {
    const f = await proactive();
    const id = await f.controller.enqueue('event', 'fixture', now + 1000);
    const runner = { fire: vi.fn(async () => ({ sessionId: 'ordinary' })) };
    const wrapped = withCompanionSchedules(runner);
    const unbind = bindCompanionSchedule('schedule-fixture', { sessionId: binding.sessionId, controller: f.controller, outboxId: id, assertCurrent: f.current });
    const context = { runId: 'run', firedAt: now, signal: new AbortController().signal };
    try {
      expect(await wrapped.fire({ id: 'schedule-fixture', projectConfigId: 'companion-proactive-fixture' } as never, context)).toEqual({ sessionId: binding.sessionId, skipped: false });
      expect(await wrapped.fire({ id: 'other' } as never, context)).toEqual({ sessionId: 'ordinary' });
      expect(await wrapped.fire({ id: 'unbound-after-restart', projectConfigId: 'companion-proactive-fixture' } as never, context)).toEqual({ sessionId: '', skipped: true });
      expect(runner.fire).toHaveBeenCalledTimes(1);
    } finally { unbind(); }
  });
});
