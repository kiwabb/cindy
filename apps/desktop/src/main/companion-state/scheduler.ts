import type { ScheduleRunner, Schedule, FireContext, FireResult } from '@cindy/maker-scheduler';
import type { ProactiveController } from './proactive.js';

export const COMPANION_SCHEDULE_PREFIX = 'companion-proactive-';

/** Explicit Main bindings only. Empty at startup: every ordinary schedule keeps its runner. */
const bindings = new Map<string, { sessionId: string; controller: ProactiveController; outboxId: string; assertCurrent(): void }>();
export function bindCompanionSchedule(scheduleId: string, binding: {
  sessionId: string; controller: ProactiveController; outboxId: string; assertCurrent(): void;
}): () => void {
  binding.assertCurrent();
  if (bindings.has(scheduleId)) throw new Error('COMPANION_SCHEDULE_ALREADY_BOUND');
  bindings.set(scheduleId, binding);
  return () => { if (bindings.get(scheduleId) === binding) bindings.delete(scheduleId); };
}
/** Reuses scheduler's cancellation, execution lock and receipt history. Creates no schedule. */
export function withCompanionSchedules(runner: ScheduleRunner): ScheduleRunner {
  return { async fire(schedule: Schedule, context: FireContext): Promise<FireResult> {
    const binding = bindings.get(schedule.id);
    if (!binding) return schedule.projectConfigId?.startsWith(COMPANION_SCHEDULE_PREFIX)
      ? { sessionId: '', skipped: true } : runner.fire(schedule, context);
    if (!schedule.projectConfigId?.startsWith(COMPANION_SCHEDULE_PREFIX)) throw new Error('COMPANION_SCHEDULE_KIND_MISMATCH');
    binding.assertCurrent();
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const cancel = () => binding.controller.dispose();
    context.signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await binding.controller.dispatch(binding.outboxId);
      binding.assertCurrent();
      if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // Never turn an unknown delivery into a scheduler success receipt.
      if (result.status === 'unknown') throw new Error('COMPANION_DELIVERY_UNKNOWN');
      return { sessionId: binding.sessionId, skipped: result.status !== 'delivered' };
    } finally { context.signal.removeEventListener('abort', cancel); }
  } };
}
