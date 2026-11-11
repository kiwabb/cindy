/**
 * Calendar arithmetic on local dates ("YYYY-MM-DD") and zone-aware instants, shared by the
 * composer's date phrase parser, its quick dates and the due text. Dates are plain strings in the
 * deadline's own time zone; nothing here reads the system zone.
 */
import { todoLocalDate, type TodoDeadline } from '@cindy/maker-shared/teammate-todo';

const DAY_MS = 86_400_000;

function utcMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(utcMidnight(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function dayDiff(to: string, from: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

/** 0 is Sunday. */
export function weekdayIndex(date: string): number {
  return new Date(utcMidnight(date)).getUTCDay();
}

/** The Monday strictly after `date`; weeks run Monday to Sunday. */
export function nextMonday(date: string): string {
  return addDays(date, ((8 - weekdayIndex(date)) % 7) || 7);
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((item) => item.type === type)!.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` `time` (HH:mm), or null when that
 * wall time does not exist there (a spring-forward gap) or the zone is unknown.
 */
export function zonedInstant(date: string, time: string, timeZone: string): string | null {
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(wall)) return null;
  try {
    let guess = wall - zoneOffsetMs(wall, timeZone);
    guess = wall - zoneOffsetMs(guess, timeZone);
    const instant = new Date(guess);
    const back = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
    const read = (type: string) => Number(back.find((item) => item.type === type)!.value);
    if (todoLocalDate(instant, timeZone) !== date || read('hour') !== hour || read('minute') !== minute)
      return null;
    return instant.toISOString();
  } catch {
    return null;
  }
}

/** Date-only without a time; with a valid HH:mm an instant that falls on `date` in `timeZone`. */
export function buildDeadline(
  date: string,
  time: string | null | undefined,
  timeZone: string,
): TodoDeadline {
  const at = time ? zonedInstant(date, time, timeZone) : null;
  return at
    ? { kind: 'instant', date, at, timeZone }
    : { kind: 'date', date, timeZone };
}

export type QuickDate = 'today' | 'tomorrow' | 'nextMonday';

/** The date a quick choice means today, in `timeZone`. */
export function quickDate(choice: QuickDate, now: Date, timeZone: string): string {
  const today = todoLocalDate(now, timeZone);
  return choice === 'today'
    ? today
    : choice === 'tomorrow'
      ? addDays(today, 1)
      : nextMonday(today);
}
