/** Actual registered IPC -> production resolver/service/store, temporary SQLite/files only.
 * Analysis is an explicit local fixture function; no application, model or user data. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import Database from 'better-sqlite3';
import {it,expect,vi} from 'vitest';
import {MakerMemoryStore} from '@cindy/maker-core';
import {createBotMemoryAccess} from '../botMemoryAccess.js';
import {registerBotPrivateFactIpc} from '../botPrivateFactIpc.js';
it('registered private correction/delete invalidates real derived FTS and rejects old sources without touching project memory',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'private-ipc-fixture-')));
 const botId='fixture-bot',sessionId='fixture-session',dir=path.join(root,'bots',botId,'memories'),workspace=path.join(root,'bots',botId,'workspace');
 fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(workspace,{recursive:true});
 const db=new Database(path.join(dir,'fts.db'));
 const logger:any={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return logger}};
 const store=new MakerMemoryStore({storageDir:dir,absWorkdir:'bot:'+botId,db,logger});
 const route={providerId:'fixture',model:'fixture',protocol:'openai-responses' as const,baseUrl:'http://127.0.0.1:1/v1'};
 const analyze=vi.fn(async()=>({route,changes:[{action:'ADD',name:'fruit',title:'Fruit',description:'fixture lime',body:'用户喜欢青柠。',quote:'我喜欢青柠',subject:'user'}]}));
 const queue=await store.createFactMemory({scope:{ownerId:'fixture-owner',botId},selectedRoute:route,port:{route,analyze:analyze as any},assertCurrentScope:()=>{}});
 const source={sessionId,logicalTurnId:'fixture-turn',userMessageId:'fixture-message',generation:1,userText:'我喜欢青柠',origin:'user' as const};
 const access=createBotMemoryAccess({readBot:async id=>id===botId?{root,canonicalSessionId:sessionId,projectMode:true,privateCompanion:true,assertCurrent(){},assertExclusiveWorkspace:async()=>{}}:null,getStore:async scope=>{if(scope!=='bot:'+botId)throw Error('PROJECT_STORE_NOT_ALLOWED_IN_THIS_FIXTURE');return store},requestRefresh:async()=>{}});
 const handlers=new Map<string,Function>();const dispose=registerBotPrivateFactIpc({ipc:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},assertTrusted:e=>{if(e!==('local-settings' as any))throw Error('UNTRUSTED')},captureOwner:()=>({assertCurrent(){}}),getService:()=>access.privateService});
 const call=(op:string,body:any)=>handlers.get('local-db:bots:private-facts:'+op)!('local-settings',body);
 try {
  queue.finish(queue.prepare(source),'completed',1);await queue.drain();
  const {items,source:tag}=await call('list',{botId});expect(tag).toBe('bot-private');expect(items).toHaveLength(1);const fact=items[0];
  expect((await store.search('青柠')).some(x=>x.filename==='digest_fact_summary.md')).toBe(true);
  const pending=queue.prepare({...source,logicalTurnId:'pending-fixture',userMessageId:'pending-message',generation:2});
  const corrected=await call('update',{botId,filename:fact.filename,title:'Corrected',body:'用户喜欢梨。',expectedUpdatedAt:fact.updatedAt});
  expect((await store.search('青柠')).length).toBe(0);
  expect((await store.list()).some(x=>x.filename==='digest_fact_summary.md')).toBe(false);
  await expect(call('delete',{botId,filename:fact.filename,expectedUpdatedAt:fact.updatedAt})).rejects.toThrow();
  await call('delete',{botId,filename:fact.filename,expectedUpdatedAt:corrected.item.updatedAt});
  expect(await store.search('梨')).toEqual([]);expect((await call('list',{botId})).items).toEqual([]);
  queue.finish(pending,'completed',2);queue.finish(queue.prepare({...source,generation:3}),'completed',3);await queue.drain();
  expect(await store.search('青柠')).toEqual([]);expect(await store.list()).toEqual([]);
  await expect(call('list',{botId:'another-bot'})).rejects.toThrow();
  expect(analyze).toHaveBeenCalledOnce();
 } finally {dispose();access.invalidate();queue.dispose();db.close();fs.rmSync(root,{recursive:true,force:true});}
});
