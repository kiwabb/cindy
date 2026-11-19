/** Pure host-source fixtures; no storage, credentials, transport or model. */
import {it,expect} from 'vitest';
import {readNativeFactUserSource} from '../nativeFactMemory.js';
it('accepts verified desktop authored text and preserves message reference',()=>{
 expect(readNativeFactUserSource({origin:{kind:'desktop'},rawChannelText:'fixture authored text'}, {clientId:'fixture-id'},undefined)).toEqual({messageId:'fixture-id',text:'fixture authored text'});
});
it('rejects untrusted/machine origins, automatic continuation and retry source reconstruction',()=>{
 const context={origin:{kind:'desktop'},rawChannelText:'fixture authored text'};
 expect(readNativeFactUserSource(undefined,{clientId:'fixture-id'},undefined)).toBeUndefined();
 for(const kind of ['scheduler','bot','plugin','feishu'])expect(readNativeFactUserSource({...context,origin:{kind}},{clientId:'fixture-id'},undefined)).toBeUndefined();
 expect(readNativeFactUserSource(context,{clientId:'fixture-id',autoResume:true},undefined)).toBeUndefined();
 expect(readNativeFactUserSource(context,{clientId:'fixture-id'},'original-id')).toBeUndefined();
});

it('accepts ordinary Main-stamped queue text without Pi privilege and rejects other queues',()=>{
 const persisted={clientId:'fixture-queue-id'};
 const queue={ordinary:true,authoredText:'fixture authored queue text',remote:false};
 expect(readNativeFactUserSource(undefined,persisted,undefined,queue)).toEqual({messageId:persisted.clientId,text:queue.authoredText});
 for(const q of [{...queue,ordinary:false},{...queue,remote:true},{...queue,authoredText:''},{...queue,authoredText:undefined}])expect(readNativeFactUserSource(undefined,persisted,undefined,q)).toBeUndefined();
 for(const metadata of [{sourcePlugin:{}},{botTaskCoordination:{}},{sharedTaskAuthor:{}}])expect(readNativeFactUserSource(undefined,{...persisted,...metadata},undefined,queue)).toBeUndefined();
 expect(readNativeFactUserSource(undefined,persisted,'prior-id',queue)).toBeUndefined();
});
