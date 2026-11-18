import type {BotMemoryDeleteInput,BotMemoryDetail,BotMemorySummary,BotMemoryUpdateInput} from '../../../shared/botMemory';

type Envelope<T>={source:'bot-private';botId:string}&T;
export interface PrivateBotMemoryApi {
  list(body:{botId:string;query?:string}):Promise<Envelope<{items:BotMemorySummary[]}>>;
  read(body:{botId:string;filename:string}):Promise<Envelope<{item:BotMemoryDetail}>>;
  update(body:BotMemoryUpdateInput):Promise<Envelope<{item:BotMemoryDetail}>>;
  delete(body:BotMemoryDeleteInput):Promise<Envelope<{deleted:true}>>;
}
/** A view-scoped adapter for the existing editor; never changes target.memory.
 * The page must dispose on owner/bot/source navigation and supply its owner epoch fence. */
export function createPrivateBotMemoryAccess(input:{botId:string;assertCurrent():void},api:()=>PrivateBotMemoryApi){
 let disposed=false;
 const current=(botId:string)=>{
  if(disposed)throw new Error('PRIVATE_MEMORY_VIEW_STALE');
  input.assertCurrent();if(botId!==input.botId)throw new Error('PRIVATE_MEMORY_VIEW_WRONG_BOT');
 };
 const response=<T>(botId:string,result:Envelope<T>)=>{
  current(botId);if(result.source!=='bot-private'||result.botId!==botId)throw new Error('PRIVATE_MEMORY_RESPONSE_SCOPE');return result;
 };
 const item=(botId:string,filename:string,result:Envelope<{item:BotMemoryDetail}>)=>{
  const value=response(botId,result).item;if(value.filename!==filename)throw new Error('PRIVATE_MEMORY_RESPONSE_FILE');return value;
 };
 return {dispose(){disposed=true;},memory:{
  async list(botId:string,query?:string){current(botId);return response(botId,await api().list({botId,query})).items;},
  async read(botId:string,filename:string){current(botId);return item(botId,filename,await api().read({botId,filename}));},
  async update(body:BotMemoryUpdateInput){current(body.botId);return item(body.botId,body.filename,await api().update(body));},
  async delete(body:BotMemoryDeleteInput){current(body.botId);const receipt=response(body.botId,await api().delete(body));if(receipt.deleted!==true)throw new Error('PRIVATE_MEMORY_DELETE_UNCONFIRMED');},
 }};
}
export type PrivateBotMemoryAccess=ReturnType<typeof createPrivateBotMemoryAccess>;
