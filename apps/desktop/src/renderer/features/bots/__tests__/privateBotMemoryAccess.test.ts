/** Pure renderer adapter fixtures; no UI mount, IPC transport, model or user data. */
import {expect,it,vi} from 'vitest';
import {createPrivateBotMemoryAccess} from '../privateBotMemoryAccess';
function setup(){
 const record={filename:'user_fixture.md',type:'user' as const,title:'fixture',body:'fixture',updatedAt:'v1'};
 const envelope={source:'bot-private' as const,botId:'fixture',item:record};
 const api={list:vi.fn(async()=>({...envelope,items:[{...record,preview:'fixture'}]})),read:vi.fn(async()=>envelope),update:vi.fn(async()=>envelope),delete:vi.fn(async()=>({...envelope,deleted:true as const}))};
 const current=vi.fn();const access=createPrivateBotMemoryAccess({botId:'fixture',assertCurrent:current},()=>api);return{access,api,current,envelope};
}
it('adapts explicit private API to the unchanged editor shape without losing version',async()=>{
 const f=setup();expect(await f.access.memory.list('fixture','q')).toHaveLength(1);
 expect(f.api.list).toHaveBeenCalledWith({botId:'fixture',query:'q'});
 const update={botId:'fixture',filename:'user_fixture.md',title:'fixture',body:'fixture',expectedUpdatedAt:'v1'};
 await f.access.memory.update(update);expect(f.api.update).toHaveBeenCalledWith(update);
 await f.access.memory.delete({botId:'fixture',filename:update.filename,expectedUpdatedAt:'v1'});expect(f.api.delete).toHaveBeenCalledOnce();
});
it('does not dispatch after disposal or to another bot',async()=>{
 const f=setup();await expect(f.access.memory.list('other')).rejects.toThrow('WRONG_BOT');f.access.dispose();await expect(f.access.memory.list('fixture')).rejects.toThrow('STALE');expect(f.api.list).not.toHaveBeenCalled();
});
it('rejects a late response after view switch',async()=>{
 const f=setup();let release!:(value:any)=>void;f.api.list.mockImplementation(()=>new Promise(r=>release=r));const pending=f.access.memory.list('fixture');f.access.dispose();release({...f.envelope,items:[]});await expect(pending).rejects.toThrow('STALE');
});
it('rejects account epoch changes and mismatched source/file without ordinary memory fallback',async()=>{
 const f=setup();f.current.mockImplementation(()=>{throw Error('OWNER_CHANGED')});await expect(f.access.memory.list('fixture')).rejects.toThrow('OWNER_CHANGED');expect(f.api.list).not.toHaveBeenCalled();
 f.current.mockImplementation(()=>{});f.api.read.mockResolvedValue({...f.envelope,source:'project' as any});await expect(f.access.memory.read('fixture','user_fixture.md')).rejects.toThrow('RESPONSE_SCOPE');
 f.api.read.mockResolvedValue({...f.envelope,item:{...f.envelope.item,filename:'user_other.md'}});await expect(f.access.memory.read('fixture','user_fixture.md')).rejects.toThrow('RESPONSE_FILE');
});
