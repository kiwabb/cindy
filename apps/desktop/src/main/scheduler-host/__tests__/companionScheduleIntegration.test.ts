/** Actual nested scheduler wrappers, fake dispatch only; no schedules, model or real outbox. */
import {it,expect,vi} from 'vitest';
import {withTeammateHomeGuard} from '../teammateHomeGuard.js';
import {withCompanionSchedules,bindCompanionSchedule} from '../../companion-state/scheduler.js';
import {teammateFolderName} from '@cindy/maker-shared/teammate-project';
it('outer home guard blocks the companion dispatch and unbound reserved schedules never fall through',async()=>{
 const normal=vi.fn(async()=>({sessionId:'ordinary'}));const dispatch=vi.fn(async()=>({status:'delivered'}));
 let demoted=['fixture-bot'];const runner=withTeammateHomeGuard(withCompanionSchedules({fire:normal}),()=>demoted);
 const schedule:any={id:'fixture-schedule',projectConfigId:'companion-proactive-fixture',workingDir:`/fixture/owners/owner/bots/${teammateFolderName('fixture-bot')}/workspace`};
 const stop=bindCompanionSchedule(schedule.id,{sessionId:'fixture-session',controller:{dispatch,dispose:vi.fn()}as any,outboxId:'fixture-outbox',assertCurrent(){}});
 try {
  expect(await runner.fire(schedule,{signal:new AbortController().signal}as any)).toMatchObject({skipped:true});expect(dispatch).not.toHaveBeenCalled();expect(normal).not.toHaveBeenCalled();
  demoted=[];expect(await runner.fire(schedule,{signal:new AbortController().signal}as any)).toMatchObject({sessionId:'fixture-session',skipped:false});expect(dispatch).toHaveBeenCalledOnce();
  stop();expect(await runner.fire(schedule,{signal:new AbortController().signal}as any)).toMatchObject({skipped:true});expect(normal).not.toHaveBeenCalled();
  await runner.fire({...schedule,projectConfigId:'ordinary'}, {signal:new AbortController().signal}as any);expect(normal).toHaveBeenCalledOnce();
 }finally{stop();}
});
