/** Filesystem fixtures only; production shared resolver/service, no model or app. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {registerBotPrivateFactIpc} from '../botPrivateFactIpc.js';
import {assertExclusiveBotWorkspace,createBotMemoryAccess} from '../botMemoryAccess.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
function setup(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'memory-access-fixture-')));roots.push(root);
 const bot='fixture';const dir=path.join(root,'bots',bot,'memories');const workspace=path.join(root,'bots',bot,'workspace');
 fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(workspace);fs.writeFileSync(path.join(dir,'fts.db'),'fixture');
 const identity={scopeKey:'bot:fixture',storageDir:dir,databasePath:path.join(dir,'fts.db')};
 const record={filename:'user_fixture.md',body:'fixture body',frontmatter:{type:'user',title:'fixture',updatedAt:'2026-11-17'}};
 const store:any={getStorageIdentity:()=>identity,list:async()=>[record],search:async()=>[{filename:record.filename,type:'user'}],read:async()=>record};
 const owner={root,canonicalSessionId:'fixture-session',projectMode:true,privateCompanion:true,assertCurrent:vi.fn(),assertExclusiveWorkspace:vi.fn(async()=>{})};
 const getStore=vi.fn(async(_scope: string)=>store);const access=createBotMemoryAccess({readBot:async()=>owner,getStore,requestRefresh:async()=>{}});
 return {root,bot,workspace,identity,owner,store,getStore,access};
}
it('native list/search and automatic mechanism share private store even with projectMode',async()=>{
 const f=setup();const resolved=await f.access.resolveCompanion(f.bot);
 expect(resolved.store).toBe(f.store);expect(resolved.scopeKey).toBe('bot:fixture');
 expect((await f.access.privateService.list(f.bot)).map(x=>x.filename)).toEqual(['user_fixture.md']);
 expect((await f.access.privateService.list(f.bot,'fixture')).map(x=>x.filename)).toEqual(['user_fixture.md']);
 expect(f.getStore.mock.calls.every(([scope])=>scope==='bot:fixture')).toBe(true);
});
it.each(['shared','other-bot','project-store','symlink','owner-change'])('registered shared service refuses %s',async kind=>{
 const f=setup();
 if(kind==='shared')f.owner.assertExclusiveWorkspace.mockRejectedValue(new Error('COMPANION_SHARED_WORKSPACE'));
 if(kind==='other-bot')f.identity.scopeKey='bot:other';
 if(kind==='project-store')f.identity.storageDir=path.join(f.workspace,'.cindy','memory');
 if(kind==='symlink'){fs.rmdirSync(f.workspace);fs.symlinkSync(f.root,f.workspace);}
 if(kind==='owner-change')f.owner.assertCurrent.mockImplementation(()=>{throw new Error('OWNER_CHANGED')});
 await expect(f.access.privateService.list(f.bot)).rejects.toThrow();await expect(f.access.resolveCompanion(f.bot)).rejects.toThrow();
});
it('selection off preserves ordinary project route but refuses automatic private access',async()=>{
 const f=setup();f.owner.privateCompanion=false;
 await f.access.service.list(f.bot);expect(f.getStore.mock.calls[0][0]).toBe(f.workspace);
 await expect(f.access.resolveCompanion(f.bot)).rejects.toThrow('PRIVATE_SELECTION_REQUIRED');
});
it('resolved owner fence rejects a late change before service returns content',async()=>{
 const f=setup();f.store.list=async()=>{f.owner.assertCurrent.mockImplementation(()=>{throw new Error('OWNER_CHANGED')});return []};
 await expect(f.access.privateService.list(f.bot)).rejects.toThrow('OWNER_CHANGED');
});

it('owner session metadata cannot hide shared workspace behind another bot symlink',()=>{
 const f=setup();const alias=path.join(f.root,'other-bot-workspace');fs.symlinkSync(f.workspace,alias);
 expect(()=>assertExclusiveBotWorkspace(f.workspace,'fixture-session',[{id:'other',workingDir:alias,projectDir:null}])).toThrow('SHARED_WORKSPACE');
 expect(()=>assertExclusiveBotWorkspace(f.workspace,'fixture-session',[{id:'fixture-session',workingDir:f.workspace,projectDir:null}])).not.toThrow();
});

it.each([false,true])('ordinary project service never reroutes when companion selection=%s',async enabled=>{
 const f=setup();f.owner.privateCompanion=enabled;
 await f.access.service.list(f.bot);expect(f.getStore).toHaveBeenLastCalledWith(f.workspace);
 await f.access.privateService.list(f.bot);expect(f.getStore).toHaveBeenLastCalledWith('bot:fixture');
});
it('actual registered private IPC reaches the shared resolver and preserves editing version',async()=>{
 const f=setup();f.owner.privateCompanion=false;
 const handlers=new Map<string,Function>();
 const dispose=registerBotPrivateFactIpc({ipc:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
 assertTrusted:event=>{if(event!==('trusted' as any))throw Error('UNTRUSTED')},captureOwner:()=>f.owner,getService:()=>f.access.privateService});
 const call=(op:string,body:any,event:any='trusted')=>handlers.get('local-db:bots:private-facts:'+op)!(event,body);
 expect(await call('list',{botId:f.bot})).toMatchObject({source:'bot-private',botId:f.bot,items:[{filename:'user_fixture.md'}]});
 f.store.update=vi.fn(async(_name,_version,patch)=>({filename:'user_fixture.md',body:patch.body,frontmatter:{type:'user',title:patch.title,updatedAt:'new-version'}}));
 f.store.delete=vi.fn(async()=>{});
 expect(await call('update',{botId:f.bot,filename:'user_fixture.md',title:'Corrected',body:'corrected fixture',expectedUpdatedAt:'2026-11-17'})).toMatchObject({source:'bot-private',item:{body:'corrected fixture'}});
 expect(f.store.update).toHaveBeenCalledWith('user_fixture.md','2026-11-17',expect.objectContaining({body:'corrected fixture'}));
 await expect(call('delete',{botId:f.bot,filename:'user_fixture.md',expectedUpdatedAt:'stale'})).rejects.toThrow();expect(f.store.delete).not.toHaveBeenCalled();
 await call('delete',{botId:f.bot,filename:'user_fixture.md',expectedUpdatedAt:'2026-11-17'});expect(f.store.delete).toHaveBeenCalledWith('user_fixture.md','2026-11-17');
 for(const extra of [{ownerId:'other'},{scope:'shared'},{path:'/tmp/shared'},{source:'project'}])await expect(call('list',{botId:f.bot,...extra})).rejects.toThrow();
 await expect(call('list',{botId:f.bot},'external')).rejects.toThrow('UNTRUSTED');
 const late=handlers.get('local-db:bots:private-facts:list')!;dispose();expect(handlers.size).toBe(0);
 await expect(late('trusted',{botId:f.bot})).rejects.toThrow();f.access.invalidate();
});
it('invalidation rejects late reads and resolved contexts; subsequent epoch can read',async()=>{
 const f=setup();const resolved=await f.access.resolveCompanion(f.bot);
 const original=f.store.list;f.store.list=async()=>{f.access.invalidate();return []};
 await expect(f.access.privateService.list(f.bot)).rejects.toThrow('INVALIDATED');
 expect(()=>resolved.owner.assertCurrent()).toThrow('INVALIDATED');
 f.store.list=original;await expect(f.access.privateService.list(f.bot)).resolves.toHaveLength(1);
});
it('fresh access after restart keeps private inspection independent of the nonpersistent companion selection',async()=>{
 const f=setup();f.owner.privateCompanion=false;
 const fresh=createBotMemoryAccess({readBot:async()=>f.owner,getStore:f.getStore,requestRefresh:async()=>{}});
 await fresh.service.list(f.bot);expect(f.getStore).toHaveBeenLastCalledWith(f.workspace);
 await fresh.privateService.list(f.bot);expect(f.getStore).toHaveBeenLastCalledWith('bot:fixture');
 await expect(fresh.resolveCompanion(f.bot)).rejects.toThrow('PRIVATE_SELECTION_REQUIRED');
 fresh.invalidate();await fresh.privateService.list(f.bot);expect(f.getStore).toHaveBeenLastCalledWith('bot:fixture');
});
it('deleting one bot does not invalidate another bot store fence', async()=>{
 const f=setup(); const active=await f.access.resolveCompanion(f.bot);
 f.access.invalidate('other-bot');expect(()=>active.owner.assertCurrent()).not.toThrow();
 f.access.invalidate(f.bot);expect(()=>active.owner.assertCurrent()).toThrow('INVALIDATED');
});
