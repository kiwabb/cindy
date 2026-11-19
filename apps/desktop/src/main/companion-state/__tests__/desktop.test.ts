/**
 * Production entry: createDesktopCompanionAdapters, with host I/O replaced by fixtures.
 * Contract: explicit Responses route, native publication guard and receipt truthfulness.
 * Gap: core lifecycle tests do not execute this real adapter's argument mapping.
 * Minimum failures: provider changes before dispatch; absent receipt; revoked primary device.
 * Tier: unit, no Electron startup, account access, database, model or network.
 */
import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  store: undefined as unknown as StateStore,
  homeListeners: new Set<() => void>(),
  home: { enabled: false, selfDeviceId: null as string | null, actors: [] as Array<{ externalId: string; homeDeviceId: string | null }>, demotedBotIds: [] as string[] },
  canonicalBarrier: undefined as Promise<void> | undefined,
  active: { dataOwnerId: 'owner', generation: 1 },
  query: [] as Array<Record<string, unknown>>,
  send: vi.fn(), request: vi.fn(), executor: vi.fn(), drain: vi.fn(), select: vi.fn(),
}));
vi.mock('../store.js', () => ({ createStateStore: () => fixture.store }));
vi.mock('../../companion-cloud/homes.js', () => ({ companionHomes: { snapshot: () => fixture.home, onChange: (cb: () => void) => { fixture.homeListeners.add(cb); return () => fixture.homeListeners.delete(cb); } } }));
vi.mock('../../maker-host/fact-analysis-responses.desktop.js', () => ({ createDesktopResponsesTextPort: (_id: string, route: unknown) => ({ route, request: fixture.request }) }));
vi.mock('drizzle-orm', () => ({ and: (...args: unknown[]) => args, eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args, isNull: (...args: unknown[]) => args, desc: (...args: unknown[]) => args }));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => fixture.active, activeOwnerScopeKey: () => String(fixture.active.generation), ownerScopedUserDataPath: () => '/fixture-private-root' }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => ({ ownerId: 'owner' }) }));
vi.mock('../../device-link/crossProcessLock.js', () => ({ withCrossProcessLock: vi.fn(() => { throw new Error('UNEXPECTED_FIXTURE_STORAGE_WRITE'); }) }));
vi.mock('../../messagePersistBroadcaster.desktop.js', () => ({ drainPersistQueue: fixture.drain }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: { select: () => {
  fixture.select();
  const chain: Record<string, unknown> = {};
  for (const key of ['from', 'innerJoin', 'where', 'orderBy']) chain[key] = () => chain;
  chain.limit = async () => { await fixture.canonicalBarrier; return fixture.query; };
  chain.then = (resolve: (rows: unknown) => unknown) => Promise.resolve(fixture.query).then(resolve);
  return chain;
} } }) }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: fixture.send }));
vi.mock('../../localDb/schema.js', () => ({ botProfiles: {}, botSessionLinks: {}, messages: {}, sessions: {} }));
vi.mock('../../maker-ipc/botProfileLock.js', () => ({ withBotProfileLocks: async (_ids: unknown, run: () => unknown) => run() }));
vi.mock('../../maker-ipc/botReadStateStore.js', () => ({ readBotReadPosition: () => null }));
import { bindCompanionSchedule } from '../scheduler.js';
import { createLocalCompanionState } from '../localLifecycle.js';
import { activateCompanionState } from '../service.js';
import { createDesktopCompanionAdapters } from '../desktop.js';
import { bindCompanionStateTurns, withCompanionStateTurn, finishCompanionStateTurn } from '../nativeTurns.js';
import { CompanionStateRuntime } from '../runtime.js';
import { assertTurn } from '../affect.js';
import { initialState } from '../types.js';
import type { StateStore } from '../store.js';
import type { OutboxItem, CompletedTurn } from '../types.js';
const binding = { ownerId: 'owner', botId: 'bot', sessionId: 'session', ownerEpoch: '1', instanceId: 'instance', deviceId: 'device' };
const route = { providerId: 'fixture-sub2api', model: 'gpt-6-astra', protocol: 'openai-responses' as const, baseUrl: 'http://127.0.0.1:18080/v1' };
const port = { route, request: fixture.request };
const item: OutboxItem = { id: 'outbox', eventId: 'event', sessionId: 'session', deviceId: 'device', ownerEpoch: '1', instanceId: 'instance', day: '2026-11-17', createdAt: 1, expiresAt: 8.64e15, text: 'fixture', status: 'sending', attemptId: 'attempt' };
const make = () => createDesktopCompanionAdapters(binding, { assertCurrent() {}, assertExecutor: fixture.executor, responses: port });
beforeEach(() => { fixture.active = { dataOwnerId: 'owner', generation: 1 }; fixture.query = []; fixture.send.mockReset(); fixture.request.mockReset(); fixture.executor.mockReset(); fixture.drain.mockReset(); fixture.select.mockReset(); fixture.canonicalBarrier = undefined;
  fixture.homeListeners.clear();
  fixture.home = { enabled: false, selfDeviceId: null, actors: [], demotedBotIds: [] };
  const state = initialState(binding);
  fixture.store = { read: vi.fn(async () => structuredClone(state)), update: vi.fn(async (_revision, mutate) => {
    const result = mutate(state); state.revision++; return result;
  }) };
});
it('uses the explicit custom Responses port for both analysis and fiction requests', async () => {
  fixture.query = [{ id: 'session' }];
  fixture.request.mockImplementation(async input => {
    expect(input.route).toEqual(route); expect(input.signal).toBeInstanceOf(AbortSignal);
    return { route: { ...route }, text: '{"valence":"neutral","intensity":0,"relationship":"none"}' };
  });
  const adapter = make();
  expect(await adapter.analysis.analyze('fixture', route, new AbortController().signal)).toEqual({ valence: 'neutral', intensity: 0, relationship: 'none' });
  fixture.request.mockResolvedValue({ route, text: '{"title":"fiction activity"}' });
  expect(await adapter.request('fiction', route, new AbortController().signal)).toBe('{"title":"fiction activity"}');
  expect(fixture.request).toHaveBeenCalledTimes(2);
});
it('rejects missing selection, model/upstream drift, revoked requests and late mismatched receipts without fallback', async () => {
  fixture.query = [{ id: 'session' }];
  const signal = new AbortController().signal;
  const absent = createDesktopCompanionAdapters(binding, { assertCurrent() {}, assertExecutor: fixture.executor });
  await expect(absent.request('fixture', route, signal)).rejects.toThrow('RESPONSES_PORT_REQUIRED');
  const adapter = make();
  for (const changed of [{ ...route, providerId: 'other' }, { ...route, model: 'other' }, { ...route, baseUrl: 'http://127.0.0.1:18081/v1' }])
    await expect(adapter.request('fixture', changed, signal)).rejects.toThrow('MODEL_ROUTE_CHANGED');
  expect(fixture.request).not.toHaveBeenCalled();
  fixture.request.mockRejectedValue(new Error('A2_REVOKED'));
  await expect(adapter.request('fixture', route, signal)).rejects.toThrow('A2_REVOKED');
  expect(fixture.request).toHaveBeenCalledTimes(1);
  fixture.request.mockResolvedValue({ route: { ...route, model: 'other' }, text: 'discard' });
  await expect(adapter.request('fixture', route, signal)).rejects.toThrow('MODEL_ROUTE_CHANGED');
  expect(fixture.request).toHaveBeenCalledTimes(2);
  const abort = new AbortController(); abort.abort();
  await expect(adapter.request('fixture', route, abort.signal)).rejects.toThrow();
  expect(fixture.request).toHaveBeenCalledTimes(2);
});
it('absent receipt stays unknown and a matching native row supplies its durable id', async () => {
  const adapter = make();
  expect(await adapter.delivery.lookup(item)).toEqual({ status: 'unknown' });
  fixture.query = [{ id: 'native-message', content: 'fixture' }];
  expect(await adapter.delivery.lookup(item)).toEqual({ status: 'delivered', messageId: 'native-message' });
  fixture.query = [{ id: 'native-message', content: 'other text' }];
  await expect(adapter.delivery.lookup(item)).rejects.toThrow('RECEIPT_CONFLICT');
  expect(fixture.send).not.toHaveBeenCalled();
});
it('owner replacement and primary-device revocation prevent native publication', async () => {
  const adapter = make(); fixture.active.generation++;
  await expect(adapter.delivery.send(item, new AbortController().signal)).rejects.toThrow('OWNER_CHANGED');
  fixture.active.generation--; fixture.query = [{ id: 'session' }];
  fixture.executor.mockRejectedValue(new Error('EXECUTOR_REVOKED'));
  await expect(adapter.delivery.send(item, new AbortController().signal)).rejects.toThrow('EXECUTOR_REVOKED');
  expect(fixture.send).not.toHaveBeenCalled();
});

// Regression: durable unrelated rows must never authorize a completed logical turn.
it('requires terminal-minted same-turn evidence despite both clientIds existing', async () => {
  fixture.query = [{ id: 'session', role: 'user', clientId: 'user' }, { role: 'assistant', clientId: 'assistant' },
    { role: 'assistant', clientId: 'unrelated-assistant' }];
  const adapter = make();
  const session = { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null };
  let work!: Promise<void>;
  let terminal!: CompletedTurn;
  const unbind = bindCompanionStateTurns(session, { binding, assertCurrent() {}, reportFailure: vi.fn(), completed: turn => {
    terminal = turn;
    work = (async () => {
      expect(await adapter.verify({ ...turn }, turn)).toBe(true);
      for (const patch of [{ instanceId: 'other' }, { generation: turn.generation + 1 }, { assistantMessageId: 'unrelated-assistant' }]) {
        await expect(adapter.verify({ ...turn, ...patch }, turn)).rejects.toThrow('TERMINAL_PROOF_REQUIRED');
      }
      await expect(adapter.verify({ ...turn }, { ...turn })).rejects.toThrow('TERMINAL_PROOF_REQUIRED');
    })();
    return work;
  } });
  try {
    await withCompanionStateTurn(session, { logicalTurnId: 'logical', userMessageId: 'user', userText: 'fixture', origin: 'user' }, async reserved => {
      reserved?.(7); return { accepted: true } as never;
    });
    finishCompanionStateTurn(session, 7, 'completed', 'assistant');
    await work;
    unbind();
    await expect(adapter.verify(terminal, terminal)).rejects.toThrow(/TERMINAL_PROOF/);
    expect(fixture.request).not.toHaveBeenCalled();
  } finally { unbind(); }
});

it('does not activate without an explicit Responses route and port', () => {
  expect(activateCompanionState({ enabled: false } as never)).toBeNull();
  expect(() => activateCompanionState({ enabled: true } as never)).toThrow('EXPLICIT_MODEL_REQUIRED');
  expect(() => activateCompanionState({ enabled: true, route } as never)).toThrow('RESPONSES_PORT_REQUIRED');
  expect(() => activateCompanionState({ enabled: true, route, responses: { ...port, route: { ...route, model: 'other' } } } as never)).toThrow('MODEL_ROUTE_CHANGED');
  expect(fixture.request).not.toHaveBeenCalled();
});

// Regression: terminal queues the assistant write; row reads and analysis must follow its drain.
// Unit fixture, deferred host I/O only. Missing rows after drain remain an explicit failure.
it.each(['success', 'owner-change', 'dispose', 'drain-failure', 'missing-row'] as const)(
  'waits for persisted completion before reading or analysis: %s', async outcome => {
    let release!: () => void, reject!: (reason: Error) => void;
    const pending = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    fixture.drain.mockImplementation(() => pending);
    let active = true;
    const current = () => { if (!active) throw Error('FIXTURE_DISPOSED'); };
    const adapter = createDesktopCompanionAdapters(binding, { assertCurrent: current, assertExecutor: fixture.executor, responses: port });
    const state = initialState(binding);
    const store: StateStore = { read: async () => structuredClone(state), update: async (_revision, mutate) => {
      const result = mutate(state); state.revision++; return result;
    } };
    const analysis = { analyze: vi.fn(async () => ({ valence: 'neutral' as const, intensity: 0, relationship: 'none' as const })) };
    const runtime = new CompanionStateRuntime({ enabled: true, binding, route, store, assertCurrent: current, verify: adapter.verify, analysis });
    const session = { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null };
    let work!: Promise<void>;
    const unbind = bindCompanionStateTurns(session, { binding, assertCurrent: current, reportFailure: vi.fn(), completed: (turn, source) => {
      work = runtime.complete(turn, source.userText); return work;
    } });
    try {
      await withCompanionStateTurn(session, { logicalTurnId: 'logical', userMessageId: 'user', userText: 'fixture', origin: 'user' }, async reserved => {
        reserved?.(8); return { accepted: true } as never;
      });
      finishCompanionStateTurn(session, 8, 'completed', 'assistant');
      await Promise.resolve();
      expect(fixture.drain).toHaveBeenCalledOnce();
      expect(fixture.select).not.toHaveBeenCalled(); expect(analysis.analyze).not.toHaveBeenCalled();
      fixture.query = [{ id: 'session', role: 'user', clientId: 'user' }, { role: 'assistant', clientId: 'assistant' }];
      if (outcome === 'owner-change') fixture.active.generation++;
      if (outcome === 'dispose') { active = false; unbind(); runtime.dispose(); }
      if (outcome === 'missing-row') fixture.query = [{ id: 'session' }];
      if (outcome === 'drain-failure') reject(Error('FIXTURE_PERSIST_FAILED')); else release();
      if (outcome === 'success') {
        await work;
        finishCompanionStateTurn(session, 8, 'completed', 'assistant');
        expect(analysis.analyze).toHaveBeenCalledOnce(); expect(state.revision).toBe(1);
      } else {
        await expect(work).rejects.toThrow(outcome === 'owner-change' ? 'OWNER_CHANGED' : outcome === 'dispose' ? 'DISPOSED'
          : outcome === 'drain-failure' ? 'PERSIST_FAILED' : 'NOT_DURABLE');
        expect(analysis.analyze).not.toHaveBeenCalled(); expect(state.revision).toBe(0);
        if (outcome !== 'missing-row') expect(fixture.select).not.toHaveBeenCalled();
      }
    } finally { release(); unbind(); runtime.dispose(); }
  });

// Local dialogue must not require a cloud executor; all autonomous entry points remain denied.
it('runs trusted local state and root contribution with stable device identity and no executor but refuses autonomous work', async () => {
  const session = { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null, agentKind: 'codex', model: route.model,
    getStatus: () => 'active', onStatusChange: () => () => {} };
  const service = activateCompanionState({ enabled: true, ownerId: binding.ownerId, ownerEpoch: binding.ownerEpoch, botId: binding.botId, deviceId: binding.deviceId,
    session: session as never, route, responses: port, assertCurrent() {}, reportFailure: vi.fn() })!;
  try {
    fixture.query = [{ id: 'session', role: 'user', clientId: 'user' }, { role: 'assistant', clientId: 'assistant' }];
    expect((await service.prepareContribution(new AbortController().signal)).revision).toBe(0);
    await expect(service.configure({ enabled: true }, 0)).rejects.toThrow('EXECUTOR_REQUIRED');
    await expect(service.enqueue('event', 'fixture', Date.now() + 1000)).rejects.toThrow('EXECUTOR_REQUIRED');
    await expect(service.enqueuePlan('plan', 'fixture')).rejects.toThrow('EXECUTOR_REQUIRED');
    await expect(service.bindSchedule('schedule', 'outbox')).rejects.toThrow('EXECUTOR_REQUIRED');
    await expect(service.recover()).rejects.toThrow('EXECUTOR_REQUIRED');
    expect(fixture.store.update).not.toHaveBeenCalled(); expect(fixture.request).not.toHaveBeenCalled();
    let committed!: () => void;
    const done = new Promise<void>(resolve => { committed = resolve; });
    const state = initialState(binding);
    vi.mocked(fixture.store.update).mockImplementation(async (_revision, mutate) => { const result = mutate(state); state.revision++; committed(); return result; });
    fixture.request.mockResolvedValue({ route, text: '{"valence":"neutral","intensity":0,"relationship":"none"}' });
    await withCompanionStateTurn(session, { logicalTurnId: 'local', userMessageId: 'user', userText: 'fixture', origin: 'user' }, async reserve => {
      reserve?.(9); return { accepted: true } as never;
    });
    finishCompanionStateTurn(session, 9, 'completed', 'assistant');
    await done;
    expect(state.revision).toBe(1); expect(Object.values(state.turns)[0].generation).toBe(9);
    expect(fixture.request).toHaveBeenCalledOnce(); expect(fixture.executor).not.toHaveBeenCalled(); expect(fixture.send).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});
it('local contribution rejects canonical replacement, cancellation, owner changes, demotion and disposed bindings', async () => {
  const input = { ownerId: binding.ownerId, ownerEpoch: binding.ownerEpoch, botId: binding.botId, deviceId: binding.deviceId, route,
    session: { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null, agentKind: 'codex', model: route.model,
      getStatus: () => 'active', onStatusChange: () => () => {} } as never, assertCurrent() {}, reportFailure: vi.fn() };
  const service = createLocalCompanionState(input);
  try {
    await expect(service.prepareContribution(new AbortController().signal)).rejects.toThrow('CANONICAL_CHANGED');
    fixture.query = [{ id: 'session' }];
    expect((await service.prepareContribution(new AbortController().signal)).revision).toBe(0);
    const abort = new AbortController(); abort.abort();
    await expect(service.prepareContribution(abort.signal)).rejects.toThrow();
    fixture.active.generation++;
    await expect(service.prepareContribution(new AbortController().signal)).rejects.toThrow('OWNER_CHANGED');
    fixture.active.generation--;
    fixture.home.demotedBotIds = [binding.botId];
    await expect(service.prepareContribution(new AbortController().signal)).rejects.toThrow('LOCAL_COPY_REVOKED');
    fixture.home.demotedBotIds = []; fixture.home.actors = [{ externalId: binding.botId, homeDeviceId: 'elsewhere' }];
    await expect(service.prepareContribution(new AbortController().signal)).rejects.toThrow('LOCAL_COPY_REVOKED');
    fixture.home.actors = [];
    vi.mocked(fixture.store.read).mockImplementationOnce(async () => { service.dispose(); return initialState(binding); });
    await expect(service.prepareContribution(new AbortController().signal)).rejects.toThrow('BINDING_STALE');
    expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.send).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});

it('local demotion aborts in-flight state analysis and removes the cloud listener', async () => {
  const session = { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null, agentKind: 'codex', model: route.model,
    getStatus: () => 'active', onStatusChange: () => () => {} };
  let entered!: () => void, release!: () => void, failed!: () => void, signal!: AbortSignal;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { failed = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  fixture.request.mockImplementation(async input => { signal = input.signal; entered(); await pending;
    return { route, text: '{"valence":"neutral","intensity":0,"relationship":"none"}' }; });
  const service = createLocalCompanionState({ ownerId: binding.ownerId, ownerEpoch: binding.ownerEpoch, botId: binding.botId, deviceId: binding.deviceId,
    session: session as never, route, assertCurrent() {}, reportFailure: failed });
  try {
    fixture.query = [{ id: 'session', role: 'user', clientId: 'user' }, { role: 'assistant', clientId: 'assistant' }];
    await withCompanionStateTurn(session, { logicalTurnId: 'revoked', userMessageId: 'user', userText: 'fixture', origin: 'user' }, async reserve => {
      reserve?.(10); return { accepted: true } as never;
    });
    finishCompanionStateTurn(session, 10, 'completed', 'assistant'); await started;
    fixture.home.demotedBotIds = [binding.botId];
    for (const notify of [...fixture.homeListeners]) notify();
    expect(signal.aborted).toBe(true); expect(fixture.homeListeners.size).toBe(0);
    release(); await stopped;
    expect(fixture.store.update).not.toHaveBeenCalled(); expect(fixture.send).not.toHaveBeenCalled();
  } finally { release(); service.dispose(); }
});

it('an unavailable autonomous authority denies policy and scheduler binding without blocking local contribution', async () => {
  const service = activateCompanionState({ enabled: true, ...binding,
    session: { id: binding.sessionId, instanceId: binding.instanceId, remoteHostId: null, agentKind: 'codex', model: route.model,
      getStatus: () => 'active', onStatusChange: () => () => {} } as never,
    route, responses: port, assertCurrent() {}, reportFailure: vi.fn(), assertExecutor: fixture.executor })!;
  try {
    fixture.executor.mockRejectedValue(Error('FIXTURE_AUTHORITY_OFFLINE'));
    fixture.query = [{ id: 'session' }];
    expect((await service.prepareContribution(new AbortController().signal)).revision).toBe(0);
    expect(fixture.executor).not.toHaveBeenCalled();
    await expect(service.configure({ enabled: true }, 0)).rejects.toThrow('AUTHORITY_OFFLINE');
    await expect(service.bindSchedule('schedule', 'outbox')).rejects.toThrow('AUTHORITY_OFFLINE');
    await expect(service.enqueue('event', 'fixture', Date.now() + 1000)).rejects.toThrow('AUTHORITY_OFFLINE');
    expect(fixture.store.update).not.toHaveBeenCalled(); expect(fixture.send).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});

// In-memory scheduler binding only; no schedules, ledger, messages or HTTP are created.
it('async scheduler binding awaits authority and releases on dispose, including late grants', async () => {
  const makeService = () => activateCompanionState({enabled:true,...binding,
    session:{id:binding.sessionId,instanceId:binding.instanceId,remoteHostId:null,agentKind:'codex',model:route.model,getStatus:()=> 'active',onStatusChange:()=>()=>{}} as never,
    route,responses:port,assertCurrent(){},reportFailure:vi.fn(),assertExecutor:fixture.executor})!;
  const dummy={sessionId:'session',outboxId:'outbox',controller:{} as never,assertCurrent(){}};
  let release!:()=>void;fixture.executor.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  const service=makeService(),pending=service.bindSchedule('fixture-schedule','outbox');
  const probe=bindCompanionSchedule('fixture-schedule',dummy);probe(); // No binding before grant.
  release();const unbind=await pending;
  expect(()=>bindCompanionSchedule('fixture-schedule',dummy)).toThrow('ALREADY_BOUND');
  service.dispose();unbind();const freed=bindCompanionSchedule('fixture-schedule',dummy);freed();
  fixture.executor.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  const late=makeService(),lateBind=late.bindSchedule('fixture-late','outbox');late.dispose();release();
  await expect(lateBind).rejects.toThrow('BINDING_STALE');
  const clean=bindCompanionSchedule('fixture-late',dummy);clean();
  expect(fixture.request).not.toHaveBeenCalled();expect(fixture.send).not.toHaveBeenCalled();expect(fixture.store.update).not.toHaveBeenCalled();
});

// Unit regression: canonical check must precede dispatch and stale results must not enter analysis.
// Existing port tests pinned the route but did not cover canonical/owner changes during awaits.
it.each(['owner', 'abort'] as const)('canonical request barrier rejects %s changes before dispatch', async reason => {
  const adapter = make(); fixture.query = [{ id: 'session' }];
  let release!: () => void;
  fixture.canonicalBarrier = new Promise<void>(resolve => { release = resolve; });
  const abort = new AbortController();
  const pending = adapter.request('fixture', route, abort.signal);
  if (reason === 'owner') fixture.active.generation++; else abort.abort();
  release(); await expect(pending).rejects.toThrow();
  expect(fixture.request).not.toHaveBeenCalled();
});
it('canonical request barrier discards the response after canonical replacement', async () => {
  const adapter = make(); fixture.query = [{ id: 'session' }];
  fixture.request.mockImplementationOnce(async () => { fixture.query = []; return { route, text: 'discard' }; });
  await expect(adapter.request('fixture', route, new AbortController().signal)).rejects.toThrow('CANONICAL_CHANGED');
  expect(fixture.request).toHaveBeenCalledOnce();
});

// Unit: missing device previously bypassed binding isolation when both envelopes omitted it.
it('stable device identity is mandatory for activation and completed provenance', () => {
  const session = { id: binding.sessionId, instanceId: binding.instanceId, model: route.model,
    agentKind: 'codex', remoteHostId: null, getStatus: () => 'active', onStatusChange: () => () => {} } as never;
  let service: ReturnType<typeof activateCompanionState> = null;
  try {
    expect(() => { service = activateCompanionState({ enabled: true, ...binding, deviceId: undefined as never,
      session, route, responses: port, assertCurrent() {}, reportFailure() {} }); }).toThrow('DEVICE_ID_REQUIRED');
  } finally { (service as ReturnType<typeof activateCompanionState>)?.dispose(); }
  const turn: CompletedTurn = { ...binding, logicalTurnId: 'fixture', generation: 1, completedAt: 1,
    status: 'completed', source: 'owner-private', userMessageId: 'user', assistantMessageId: 'assistant' };
  expect(() => assertTurn({ ...turn, deviceId: undefined as never }, { ...binding, deviceId: undefined as never })).toThrow('INVALID_ID');
  expect(() => assertTurn({ ...turn, deviceId: 'different-device' }, binding)).toThrow('STALE_TURN');
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.store.update).not.toHaveBeenCalled();
});
