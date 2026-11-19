/** Actual product terminal + companion observer/runtime/desktop verifier; host IO/DB/analysis fixtures.
 * Deferred persistence represents the real FIFO boundary, never a model or production DB. */
import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({drain:vi.fn(),query:vi.fn(),durable:false,active:true,analysis:vi.fn(),failure:vi.fn(),flush:vi.fn()}));
vi.mock('../../messagePersistBroadcaster.desktop.js',()=>({
 drainPersistQueue:f.drain,flushAssistantBlock:f.flush,consumeLastAssistantPersistId:()=> 'assistant-fixture',consumeLastTopLevelAssistantPersistId:()=> 'assistant-fixture',
 flushOrphanToolResults:vi.fn(),markAssistantTurnCompleted:vi.fn(async()=>{}),markAssistantTurnFailed:vi.fn(async()=>{}),clearCodexPlanRowsForSession:vi.fn(),persistCodexPlanOnDone:vi.fn(),persistCodexPlanOnTerminalError:vi.fn(),preserveTurnPersistStateForBackground:vi.fn(),onTurnErrorEvent:vi.fn(),releaseReservedTurnErrorPersistId:vi.fn(),reserveTurnErrorPersistId:()=> 'error-fixture',resetTurnPersistState:vi.fn(),saveTurnStartedAtForDeferred:vi.fn(),isSuccessfulCodexDoneEventData:(d:any)=>d?.status==='completed'
}));
vi.mock('../../sessionTaskSummary.js',()=>({maybeGenerateSessionTaskSummary:vi.fn(async()=>{}),refreshSessionListPreview:vi.fn(async()=>{})}));
vi.mock('../botLearningTracker.js',()=>({botLearningTracker:{seal:vi.fn()}}));
vi.mock('../botLearningFeedback.js',()=>({learningTurnIdentity:()=> 'fixture'}));
vi.mock('../botGroupChatService.js',()=>({settleBotGroupLaneTerminal:vi.fn()}));
vi.mock('../nativeMemoryTurn.js',()=>({settleNativeMemoryTurn:vi.fn()}));
vi.mock('../contextOverflowRollover.js',()=>({createContextOverflowRollover:vi.fn(),isContextOverflowErrorData:()=>false,isOversizedHistoryErrorData:()=>false,isUnsupportedRequestOptionErrorData:()=>false}));
vi.mock('../../cindy-brain/index.js',()=>({hasEnabledGhostAssistantHook:()=>false,runGhostAssistantReplyHook:vi.fn()}));
vi.mock('../../cindy-brain/subscriptionGateway.js',()=>({withGhostAssistantHookModel:vi.fn()}));
vi.mock('../../logger.js',()=>({createLogger:()=>({warn:vi.fn(),info:vi.fn(),debug:vi.fn()})}));
vi.mock('../../appSessionState.js',()=>({getActiveAppSession:()=>({dataOwnerId:'owner',generation:1}),activeOwnerScopeKey:()=> 'epoch',ownerScopedUserDataPath:()=> '/fixture-owner-never-written'}));
vi.mock('../../device-link/broadcast-tap.js',()=>({captureDataOwnerBroadcastScope:vi.fn()}));
vi.mock('../../device-link/crossProcessLock.js',()=>({withCrossProcessLock:()=>{throw Error('NO_IO')}}));
vi.mock('../../localDb/ipc/messages.js',()=>({createMessage:()=>{throw Error('NO_PUBLISH')}}));
vi.mock('../../maker-ipc/botProfileLock.js',()=>({withBotProfileLocks:vi.fn()}));
vi.mock('../../maker-ipc/botReadStateStore.js',()=>({readBotReadPosition:()=>null}));
vi.mock('../../utility-model/oneShotCandidates.js',()=>({requestExplicitUtilityText:()=>{throw Error('NO_MODEL')}}));
vi.mock('../../localDb/client/current.js',()=>({getDbClient:()=>({drizzle:{select:()=>{
 f.query();const chain:any={};for(const name of ['from','innerJoin','where','orderBy'])chain[name]=()=>chain;
 chain.limit=async()=>[{id:'session'}];chain.then=(cb:any)=>Promise.resolve(f.durable?[{clientId:'user-fixture',role:'user'},{clientId:'assistant-fixture',role:'assistant'}]:[]).then(cb);return chain;
}}})}));
import {finishSessionTerminalEvent} from '../sessionEventTerminal.js';
import {bindCompanionStateTurns,withCompanionStateTurn} from '../../companion-state/nativeTurns.js';
import {CompanionStateRuntime} from '../../companion-state/runtime.js';
import {createDesktopCompanionAdapters} from '../../companion-state/desktop.js';
import {initialState} from '../../companion-state/types.js';
const binding={ownerId:'owner',ownerEpoch:'epoch',botId:'bot',sessionId:'session',instanceId:'instance',deviceId:'device'};
const session:any={id:'session',instanceId:'instance',remoteHostId:null,agentKind:'codex',model:'fixture',getObservedCurrentTurnTerminal:()=>({})};
const current=()=>{if(!f.active)throw Error('REVOKED')};
function terminal(status='completed',continuation=false){
 const event:any={type:'done',source:'codex',sessionInstanceId:'instance',sessionTurnGeneration:1,data:{status,result:'fixture reply'}};
 const deps:any={sessionListActivityTracker:{end:vi.fn()},pendingFailedTurnAssistantPersistId:new Map(),autoResumeBookkeeping:{noteFailedTurnCompletionTail:vi.fn(),consumeFailedTurnCompletionTail:()=>false,hasSuppressedError:()=>false},productTurnUsageTargetTracker:{remember:vi.fn(),finish:(_s:any,id:any)=>id},agentInputCoordinatorHolder:null,contextOverflowRolloverHolder:null,overflowSuppressedBroadcasts:new Map(),broadcastToAllWindows:vi.fn(),handleAgentIslandEventAfterBroadcast:vi.fn(),log:{warn:vi.fn()},markTurnEndedAfterPersistDrain:vi.fn(),turnModelPromiseBySession:new Map(),workerTurnStartSequencer:{waitForStart:async()=>{}},orcaTeamServiceForEvents:null};
 return finishSessionTerminalEvent(deps,session,{event,attributedEvent:event,broadcastEvent:event,eventAgentMeta:{},isContinuationBoundary:continuation,isPlannedUpgradeClose:false,isRemoteAuthRetry:false,isGatewayProxyTokenRecovery:false,pluginTargetInputIds:[]}as any,{providerGroupHoldId:null}as any);
}
beforeEach(()=>{f.active=true;f.durable=false;f.query.mockClear();f.flush.mockClear();f.failure.mockClear();f.analysis.mockReset().mockResolvedValue({valence:'neutral',intensity:0,relationship:'none'});f.drain.mockReset();});
it.each(['complete','revoke','cancel'] as const)('real terminal/desktop verification waits for durable rows: %s',async mode=>{
 let release!:()=>void;const barrier=new Promise<void>(r=>release=r);f.drain.mockReturnValue(barrier);
 const state=initialState(binding);const store={read:async()=>structuredClone(state),update:async(_rev:any,fn:any)=>{const result=fn(state);state.revision++;return result}};
 const adapters=createDesktopCompanionAdapters(binding,{assertCurrent:current,assertExecutor:async()=>{throw Error('NOT_AUTHORIZED')}});
 const runtime=new CompanionStateRuntime({enabled:true,binding,route:{providerId:'fixture-user',model:'fixture',protocol:'openai-responses',baseUrl:'http://127.0.0.1:1/v1'},store,assertCurrent:current,verify:adapters.verify,analysis:{analyze:f.analysis}});
 const completed=vi.fn((turn:any,source:any)=>runtime.complete(turn,source.userText));
 const unbind=bindCompanionStateTurns(session,{binding,assertCurrent:current,completed,reportFailure:f.failure});
 try {
  await withCompanionStateTurn(session,{logicalTurnId:'logical',userMessageId:'user-fixture',userText:'fixture text',origin:'user'},async reserved=>{reserved?.(1);return {accepted:true}});
  terminal('completed',true);expect(completed).not.toHaveBeenCalled();
  terminal(mode==='cancel'?'cancelled':'completed');await new Promise<void>(resolve=>setImmediate(resolve));
  expect(f.query).not.toHaveBeenCalled();
  expect(f.flush).toHaveBeenCalled();expect(f.analysis).not.toHaveBeenCalled();
  if(mode==='revoke'){f.active=false;runtime.dispose();unbind();}
  f.durable=true;release();
  await vi.waitFor(()=>{if(mode==='complete')expect(Object.keys(state.turns)).toHaveLength(1);else if(mode==='revoke')expect(f.failure).toHaveBeenCalled();});
  terminal(mode==='cancel'?'cancelled':'completed');await Promise.resolve();
  expect(f.analysis).toHaveBeenCalledTimes(mode==='complete'?1:0);expect(completed).toHaveBeenCalledTimes(mode==='cancel'?0:1);
 }finally{release();unbind();runtime.dispose();}
});
