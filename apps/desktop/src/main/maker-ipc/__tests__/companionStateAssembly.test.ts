/** Production assembly + fixture ports only. No Electron, credentials, ledger or network. */
import { beforeEach, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({ port: vi.fn(), activate: vi.fn(), listeners: new Set<() => void>(), home: {actors: [] as Array<{externalId:string;homeDeviceId:string}>,demotedBotIds: [] as string[]} }));
vi.mock('../../maker-host/fact-analysis-responses.desktop.js', () => ({ createDesktopResponsesTextPort: f.port }));
vi.mock('../../companion-state/service.js', () => ({ activateCompanionState: f.activate }));
vi.mock('../../companion-cloud/homes.js', () => ({ companionHomes: {snapshot:()=>f.home,onChange:(cb:()=>void)=>{f.listeners.add(cb);return ()=>{f.listeners.delete(cb);};}} }));
import { bindDesktopCompanionState, localCompanionBindingId } from '../companionStateAssembly.js';
beforeEach(() => { f.port.mockReset(); f.activate.mockReset(); f.listeners.clear(); f.home={actors:[],demotedBotIds:[]}; });
function fixture() {
  let epoch = 'epoch1', device = 'device1';
  const session: any = {id:'session',instanceId:'instance1',agentKind:'codex',model:'fixture-model',getStatus:()=> 'active'};
  const route = {providerId:'fixture-provider',model:'fixture-model',protocol:'openai-responses' as const,baseUrl:'http://127.0.0.1:1/v1'};
  const current = () => { if (epoch !== 'epoch1') throw Error('OWNER_CHANGED'); };
  const authority={scope:{ownerId:'owner',ownerEpoch:'epoch1',botId:'bot',deviceId:'device1'},assertBound:vi.fn(()=>{}),assertCurrent:vi.fn(async()=>{})};
  const service={dispose:vi.fn(),read:vi.fn(async()=>({revision:2})),prepareContribution:vi.fn(async()=>Object.freeze({revision:2,text:'fixture',sourceRefs:[]}))};
  let portGuard!:()=>void;
  f.port.mockImplementation((_id, selected, guard)=>{portGuard=guard;return {route:selected,request:vi.fn()};});
  f.activate.mockReturnValue(service);
  return {session,route,authority,service,current,portGuard:()=>portGuard(),
    input:{ownerId:'owner',ownerEpoch:'epoch1',botId:'bot',session,route,assertCurrent:current,reportFailure:vi.fn()},
    deps:{deviceId:()=>device,cloudDeviceId:()=> 'relay1',authority},changeOwner:()=>{epoch='epoch2';},changeDevice:()=>{device='device2';}};
}
it('missing device/foreign authority rejects before port or service creation',async()=>{
 const a=fixture(); await expect(bindDesktopCompanionState(a.input,{deviceId:()=>null})).rejects.toThrow('DEVICE_ID_REQUIRED');
 a.authority.scope.botId='foreign';await expect(bindDesktopCompanionState(a.input,a.deps)).rejects.toThrow('SCOPE_MISMATCH');
 expect(f.port).not.toHaveBeenCalled();expect(f.activate).not.toHaveBeenCalled();
});
it('passes the one explicit port and frozen route with root-only read contribution',async()=>{
 const a=fixture(),binding=await bindDesktopCompanionState(a.input,a.deps);
 const call=f.activate.mock.calls[0][0];expect(call).toMatchObject({ownerId:'owner',ownerEpoch:'epoch1',botId:'bot',deviceId:'device1',session:a.session,enabled:true});
 expect(call.responses).toBe(f.port.mock.results[0].value);expect(f.port.mock.calls[0].slice(0,2)).toEqual(['session',a.route]);expect(Object.isFrozen(call.route)).toBe(true);
 expect(call.responses.request).not.toHaveBeenCalled();expect(a.service.read).not.toHaveBeenCalled();
 const signal=new AbortController().signal;expect(await binding.contribute(signal)).toMatchObject({revision:2});expect(a.service.prepareContribution).toHaveBeenCalledOnce();
 binding.dispose();binding.dispose();expect(a.service.dispose).toHaveBeenCalledOnce();expect(()=>a.portGuard()).toThrow('STALE');
});
it.each(['owner','instance','model','device'] as const)('rejects stale %s through the actual port guard',async kind=>{
 const a=fixture();await bindDesktopCompanionState(a.input,a.deps);
 if(kind==='owner')a.changeOwner();if(kind==='instance')a.session.instanceId='new';if(kind==='model')a.session.model='other';if(kind==='device')a.changeDevice();
 expect(()=>a.portGuard()).toThrow();
});
it('revalidates scope after authority await and discards a late context after dispose',async()=>{
 const a=fixture();a.authority.assertCurrent.mockImplementationOnce(async()=>{a.changeOwner();});await expect(bindDesktopCompanionState(a.input,a.deps)).rejects.toThrow('OWNER_CHANGED');expect(f.port).not.toHaveBeenCalled();
 const b=fixture(),binding=await bindDesktopCompanionState(b.input,b.deps);
 let release!:(value:any)=>void;b.service.prepareContribution.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const pending=binding.contribute(new AbortController().signal);binding.dispose();release({revision:3});await expect(pending).rejects.toThrow('STALE');
});

it('cancelled root prepare cannot publish a late state contribution',async()=>{
 const a=fixture(),binding=await bindDesktopCompanionState(a.input,a.deps);let release!:(value:any)=>void;
 a.service.prepareContribution.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const abort=new AbortController();
 const pending=binding.contribute(abort.signal);abort.abort();release({revision:3});await expect(pending).rejects.toThrow();binding.dispose();
});

it('revoked executor lease rejects transport and contribution before IO',async()=>{
 const a=fixture(),binding=await bindDesktopCompanionState(a.input,a.deps);a.authority.assertBound.mockImplementation(()=>{throw Error('LEASE_REVOKED');});
 expect(()=>a.portGuard()).toThrow('LEASE_REVOKED');await expect(binding.contribute(new AbortController().signal)).rejects.toThrow('LEASE_REVOKED');expect(a.service.read).not.toHaveBeenCalled();binding.dispose();
});

it('local opt-in keeps device and route fences without granting autonomous authority',async()=>{
 const a=fixture(),binding=await bindDesktopCompanionState(a.input,{deviceId:a.deps.deviceId});
 expect(f.activate.mock.calls[0][0].assertExecutor).toBeUndefined();
 expect(f.activate.mock.calls[0][0].deviceId).toBe('device1');
 await binding.contribute(new AbortController().signal);
 expect(a.authority.assertCurrent).not.toHaveBeenCalled();
 f.home.demotedBotIds=['bot'];for(const cb of [...f.listeners])cb();
 expect(a.service.dispose).toHaveBeenCalledOnce();expect(f.listeners.size).toBe(0);
 expect(()=>a.portGuard()).toThrow('STALE');
});
it('known foreign home rejects local opt-in before transport creation',async()=>{
 const a=fixture();f.home.actors=[{externalId:'bot',homeDeviceId:'foreign'}];
 await expect(bindDesktopCompanionState(a.input,{deviceId:a.deps.deviceId})).rejects.toThrow('LOCAL_COPY_REVOKED');
 expect(f.port).not.toHaveBeenCalled();
});

it('keeps local identity stable across no-ack binds without equating it with a relay home', async()=>{
 const a=fixture();const local=localCompanionBindingId('/fixture/profile','real-host-fixture');
 expect(local).toBe(localCompanionBindingId('/fixture/profile','real-host-fixture'));
 expect(local).not.toBe(localCompanionBindingId('/fixture/other-profile','real-host-fixture'));
 const offline={deviceId:()=>local,cloudDeviceId:()=>null};
 const first=await bindDesktopCompanionState(a.input,offline);first.dispose();
 const second=await bindDesktopCompanionState(a.input,offline);expect(second.identity.deviceId).toBe(local);second.dispose();
 f.home.actors=[{externalId:'bot',homeDeviceId:'relay1'}];
 await expect(bindDesktopCompanionState(a.input,offline)).rejects.toThrow('LOCAL_COPY_REVOKED');
 const linked=await bindDesktopCompanionState(a.input,{deviceId:()=>local,cloudDeviceId:()=> 'relay1'});
 expect(f.activate.mock.calls.at(-1)![0].assertExecutor).toBeUndefined();linked.dispose();
 await expect(bindDesktopCompanionState(a.input,{deviceId:()=> 'relay1',cloudDeviceId:()=> 'different'})).rejects.toThrow('LOCAL_COPY_REVOKED');
});
