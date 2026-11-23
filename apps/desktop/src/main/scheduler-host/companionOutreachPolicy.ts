// Apply before generation and again before publication. The caller supplies
// host-owned facts read under the appropriate account and conversation guards.
const HOUR_MS = 3_600_000;
const DAY_LIMIT = 2;
const MIN_SPACING_MS = 3 * HOUR_MS;
export const MAX_EVENT_AGE_MS = HOUR_MS;
const shanghaiClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function localClock(at: number) {
  const fields = Object.fromEntries(shanghaiClock.formatToParts(at)
    .map(({ type, value }) => [type, value]));
  return { day: `${fields.year}-${fields.month}-${fields.day}`, hour: Number(fields.hour) };
}

export type CompanionOutreachEvent = {
  key: string;
  occurredAt: number;
};

export type CompanionOutreachDecision = 'allow' | 'disabled' | 'not-home' | 'busy'
  | 'no-fresh-event' | 'duplicate' | 'quiet-hours' | 'daily-limit' | 'minimum-spacing';

export function decideCompanionOutreach(input: {
  enabled: boolean;
  isHome: boolean;
  busy: boolean;
  now: number;
  event: CompanionOutreachEvent | null;
  // The persisted event claim prevents regenerating the same event after an
  // ambiguous or failed attempt. Published timestamps alone drive send limits.
  eventAlreadyClaimed: boolean;
  publishedAt: readonly number[];
}): CompanionOutreachDecision {
  if (!input.enabled) return 'disabled';
  if (!input.isHome) return 'not-home';
  if (input.busy) return 'busy';
  const { event, now } = input;
  if (!event?.key || !Number.isFinite(now) || !Number.isFinite(event.occurredAt)
    || event.occurredAt > now || now - event.occurredAt >= MAX_EVENT_AGE_MS) {
    return 'no-fresh-event';
  }
  if (input.eventAlreadyClaimed) return 'duplicate';
  const current = localClock(now);
  if (current.hour < 8 || current.hour >= 22) return 'quiet-hours';

  const published = input.publishedAt.filter(at => Number.isFinite(at));
  if (published.filter(at => localClock(at).day === current.day).length >= DAY_LIMIT) {
    return 'daily-limit';
  }
  if (published.some(at => now - at < MIN_SPACING_MS)) return 'minimum-spacing';
  return 'allow';
}
