/** Lifecycle unit fixtures: bindings and queue are mocked, never starts Electron or a model. */
import { it, expect, vi } from 'vitest';
const bindings = vi.hoisted(() => ({ hidden: vi.fn(() => vi.fn()), facts: vi.fn(() => vi.fn()) }));
vi.mock('../nativeMemoryTurn.js', () => ({ bindNativeMemoryTurn: bindings.hidden }));
vi.mock('../nativeFactMemory.js', () => ({ bindNativeFactMemory: bindings.facts }));
vi.mock('../privateCompanionStore.js', () => ({ assertPrivateCompanionStore: vi.fn() }));
import { CompanionMemoryRuntime } from '../companionMemoryRuntime.js';
function fixture(projectMode = false, workDir = '/fixture-not-used/bots/bot-fixture/workspace', canonicalSessionId = 'session-fixture', state?: any) {
  let provider = 'provider-fixture';
  let owner = { id: 'owner-fixture', epoch: 'epoch1', root: '/fixture-not-used' };
  const statuses = new Set<(status: string) => void>();
  let session: any = { id: 'session-fixture', instanceId: 'instance1', workDir, agentKind: 'codex', model: 'fixture-model', getStatus: () => 'active', onStatusChange: (cb: any) => { statuses.add(cb); return () => statuses.delete(cb); } };
  const queues: any[] = [];
  const createFactMemory = vi.fn(async () => { const q = { dispose: vi.fn() }; queues.push(q); return q; });
  const store = vi.fn(async () => ({ createFactMemory, getStorageIdentity: () => ({}) })); const refresh = vi.fn(async () => {});
  const runtime = new CompanionMemoryRuntime({ owner: () => owner, session: () => session, readBot: async () => ({ canonicalSessionId, deleting: false, projectMode }), store: store as any, state, provider: () => provider, analysis: () => ({} as any), refresh, reportFailure: vi.fn() });
  const selection = { ownerId: owner.id, botId: 'bot-fixture', sessionId: session.id, route: { providerId: 'provider-fixture', model: session.model, protocol: 'openai-responses' as const, baseUrl: 'http://127.0.0.1:1/v1' } };
  return { runtime, selection, store, createFactMemory, queues, statuses, refresh, capability: (value:boolean) => { session.supportsHostTurnContext=value; }, changeProvider: () => { provider = 'foreign-provider'; }, changeOwner: () => { owner = { ...owner, epoch: 'epoch2' }; }, replace: () => { session = { ...session, instanceId: 'instance2' }; } };
}
it('disabled sends do no IO; close disposes and explicit selection rebinds a new Session', async () => {
  const f = fixture(); await f.runtime.ensure(f.selection.sessionId); expect(f.store).not.toHaveBeenCalled();
  await f.runtime.activate(f.selection); expect(f.queues).toHaveLength(1);
  for (const cb of [...f.statuses]) cb('closed'); expect(f.queues[0].dispose).toHaveBeenCalledOnce();
  f.replace(); await f.runtime.ensure(f.selection.sessionId); expect(f.queues).toHaveLength(2);
  f.runtime.deleteBot(f.selection.botId); expect(f.queues[1].dispose).toHaveBeenCalledOnce(); expect(f.runtime.hasSelection(f.selection.sessionId)).toBe(false);
});
it('owner replacement while creating queue disposes the unbound queue', async () => {
  const f = fixture(); f.createFactMemory.mockImplementationOnce(async () => { f.changeOwner(); const q = { dispose: vi.fn() }; f.queues.push(q); return q; });
  await expect(f.runtime.activate(f.selection)).rejects.toThrow('STALE'); expect(f.queues[0].dispose).toHaveBeenCalledOnce();
  expect(f.runtime.hasSelection(f.selection.sessionId)).toBe(false);
});
it('rejects foreign owner and non-loopback route without opening storage', async () => {
  const f = fixture();
  await expect(f.runtime.activate({ ...f.selection, ownerId: 'foreign' })).rejects.toThrow();
  await expect(f.runtime.activate({ ...f.selection, route: { ...f.selection.route, baseUrl: 'https://example.com/v1' } })).rejects.toThrow();
  expect(f.store).not.toHaveBeenCalled();
});
it('refreshes existing runtime resources only after committed changes and releases owner bindings', async () => {
  const f = fixture(); await f.runtime.activate(f.selection);
  const committed = (f.createFactMemory.mock.calls as unknown as [{ onCommitted(): void }][])[0][0].onCommitted;
  const afterDrain = (bindings.facts.mock.calls as unknown as any[][]).at(-1)![4];
  await afterDrain(); expect(f.refresh).not.toHaveBeenCalled(); committed(); await afterDrain(); expect(f.refresh).toHaveBeenCalledWith(f.selection.sessionId);
  f.runtime.dispose(); expect(f.queues[0].dispose).toHaveBeenCalledOnce(); expect(f.statuses.size).toBe(0);
});

it('allows projectMode only through verified private store; rejects foreign workspace and noncanonical chats', async () => {
  const own = fixture(true); await own.runtime.activate(own.selection); expect(own.store).toHaveBeenCalledOnce(); own.runtime.dispose();
  for (const foreign of [fixture(true, '/other/workspace'), fixture(true, undefined, 'other-session')]) {
    await expect(foreign.runtime.activate(foreign.selection)).rejects.toThrow('COMPANION_PRIVATE_BOT_REQUIRED');
    expect(foreign.store).not.toHaveBeenCalled();
  }
});

// Main composition fixtures; no real state ledger, database or model.
it('state opt-in composes one root contribution and shares close/rebuild/delete lifecycle', async () => {
 const states:any[]=[];const state=vi.fn(async(_input:any)=>{const bound={dispose:vi.fn(),contribute:vi.fn(async()=>({revision:1,text:'fixture',sourceRefs:[]}))};states.push(bound);return bound;});
 const f=fixture(false,undefined,undefined,state);await f.runtime.activate({...f.selection,companionState:true});
 expect(state).toHaveBeenCalledOnce();expect(state.mock.calls[0][0]).toMatchObject({ownerId:'owner-fixture',ownerEpoch:'epoch1',botId:'bot-fixture',route:f.selection.route});
 expect((bindings.hidden.mock.calls as any[][]).at(-1)![0].contribute).toBe(states[0].contribute);
 for(const cb of [...f.statuses])cb('closed');expect(states[0].dispose).toHaveBeenCalledOnce();
 f.replace();await f.runtime.ensure(f.selection.sessionId);expect(states).toHaveLength(2);
 f.runtime.deleteBot(f.selection.botId);expect(states[1].dispose).toHaveBeenCalledOnce();
 const plain=fixture(false,undefined,undefined,state);await plain.runtime.activate(plain.selection);expect(states).toHaveLength(2);plain.runtime.dispose();
});
it('blocked state authority cleans the queue and does not leave a hidden binding',async()=>{
 const state=vi.fn(async()=>{throw Error('COMPANION_EXECUTOR_AUTHORITY_UNAVAILABLE');});
 const f=fixture(false,undefined,undefined,state),calls=bindings.hidden.mock.calls.length;
 await expect(f.runtime.activate({...f.selection,companionState:true})).rejects.toThrow('AUTHORITY_UNAVAILABLE');
 expect(f.queues[0].dispose).toHaveBeenCalledOnce();expect(f.runtime.hasSelection(f.selection.sessionId)).toBe(false);expect(bindings.hidden.mock.calls.length).toBe(calls);
});
it('owner invalidation during state bind disposes the late service without installing context',async()=>{
 const bound={dispose:vi.fn(),contribute:vi.fn()};let change=()=>{};
 const state=vi.fn(async()=>{change();return bound;});const f=fixture(false,undefined,undefined,state);change=f.changeOwner;
 await expect(f.runtime.activate({...f.selection,companionState:true})).rejects.toThrow('STALE');expect(bound.dispose).toHaveBeenCalledOnce();expect(f.queues[0].dispose).toHaveBeenCalledOnce();
});

it('shares the selected provider guard with state assembly and hidden contribution',async()=>{
 let guard!:()=>void;const state=vi.fn(async(input:any)=>{guard=input.assertCurrent;return {dispose:vi.fn(),contribute:vi.fn()};});
 const f=fixture(false,undefined,undefined,state);await f.runtime.activate({...f.selection,companionState:true});
 guard();f.changeProvider();expect(()=>guard()).toThrow('STALE');f.runtime.dispose();
});

it('old peer keeps ordinary chat possible without opening or binding private memory', async () => {
  const f=fixture(); f.capability(false);
  await expect(f.runtime.activate(f.selection)).resolves.toBeUndefined();
  expect(f.store).not.toHaveBeenCalled(); expect(f.queues).toHaveLength(0);
  f.capability(true); await f.runtime.ensure(f.selection.sessionId);
  expect(f.store).toHaveBeenCalledOnce(); expect(f.queues).toHaveLength(1);
  f.capability(false); await f.runtime.ensure(f.selection.sessionId);
  expect(f.queues[0].dispose).toHaveBeenCalledOnce();
});
