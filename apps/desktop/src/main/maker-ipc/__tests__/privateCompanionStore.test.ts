/** Temporary filesystem fixtures, mock queue; no app, real user data, SQLite contents or model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../nativeMemoryTurn.js', () => ({ bindNativeMemoryTurn: () => () => {} }));
vi.mock('../nativeFactMemory.js', () => ({ bindNativeFactMemory: () => () => {} }));
import { CompanionMemoryRuntime } from '../companionMemoryRuntime.js';
import { assertPrivateCompanionStore } from '../privateCompanionStore.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
 const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'companion-private-store-fixture-'))); dirs.push(root);
 const botId = 'fixture-bot'; const storageDir = path.join(root, 'bots', botId, 'memories');
 fs.mkdirSync(storageDir, { recursive: true }); const databasePath = path.join(storageDir,'fts.db'); fs.writeFileSync(databasePath, 'fixture path only, not a database');
 const identity = { scopeKey:`bot:${botId}`, storageDir, databasePath };
 const createFactMemory = vi.fn(async () => ({dispose:vi.fn()}));
 const session:any = {id:'fixture-session',instanceId:'fixture-instance',workDir:path.join(root,'bots',botId,'workspace'),remoteHostId:null,agentKind:'codex',model:'fixture-model',getStatus:()=> 'active',onStatusChange:()=>()=>{}};
 const runtime = new CompanionMemoryRuntime({owner:()=>({id:'fixture-owner',epoch:'fixture-epoch',root}),session:()=>session,
 readBot:async()=>({canonicalSessionId:session.id,deleting:false,projectMode:false}),
 store:async()=>({getStorageIdentity:()=>identity,createFactMemory}as any),provider:()=> 'fixture-provider',analysis:()=>({}as any),refresh:async()=>{},reportFailure:vi.fn()});
 const selection={ownerId:'fixture-owner',botId,sessionId:session.id,route:{providerId:'fixture-provider',model:session.model,protocol:'openai-responses' as const,baseUrl:'http://127.0.0.1:1/v1'}};
 return {root,botId,identity,createFactMemory,runtime,selection};
}
it('accepts the exact private scope/directory/database fixture',async()=>{const f=fixture();await f.runtime.activate(f.selection);expect(f.createFactMemory).toHaveBeenCalledOnce();f.runtime.dispose();});
it.each(['project','other-bot','foreign-db'])('rejects %s storage despite valid canonical session and workspace',async kind=>{
 const f=fixture();
 if(kind==='project'){f.identity.scopeKey=path.join(f.root,'bots',f.botId,'workspace');f.identity.storageDir=path.join(f.identity.scopeKey,'.cindy','memory');f.identity.databasePath=path.join(f.identity.storageDir,'fts.db');}
 if(kind==='other-bot'){f.identity.scopeKey='bot:other-bot';f.identity.storageDir=path.join(f.root,'bots','other-bot','memories');f.identity.databasePath=path.join(f.identity.storageDir,'fts.db');}
 if(kind==='foreign-db')f.identity.databasePath=path.join(f.root,'shared-project','fts.db');
 await expect(f.runtime.activate(f.selection)).rejects.toThrow('PRIVATE_STORE_REQUIRED');expect(f.createFactMemory).not.toHaveBeenCalled();expect(f.runtime.hasSelection(f.selection.sessionId)).toBe(false);
});
it('rejects aliased DB and hard-linked DB paths',()=>{const f=fixture();const other=path.join(f.root,'other.db');fs.renameSync(f.identity.databasePath,other);fs.symlinkSync(other,f.identity.databasePath);expect(()=>assertPrivateCompanionStore(f.root,f.botId,f.identity)).toThrow('PRIVATE_STORE_REQUIRED');fs.unlinkSync(f.identity.databasePath);fs.linkSync(other,f.identity.databasePath);expect(()=>assertPrivateCompanionStore(f.root,f.botId,f.identity)).toThrow('PRIVATE_STORE_REQUIRED');});
