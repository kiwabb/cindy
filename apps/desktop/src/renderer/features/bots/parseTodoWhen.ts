/**
 * Recognises a date phrase in the title being typed in the composer. Local and deterministic:
 * no model call. Only Chinese and English phrases are recognised; every other locale returns null.
 *
 * Weeks run Monday to Sunday. A bare weekday means its next occurrence (today included);
 * "next <weekday>" / 下周X means that weekday of the following week. A time alone means today, or
 * tomorrow once that time has passed.
 *
 * Ambiguous numbers stay text: a bare 「N点」 (no 上午/下午, minutes or adjacent day word) is a count
 * as often as a time (「总结3点经验」), and English weekday abbreviations count only after
 * on / by / this / next (「sat down」, 「the sun」). Without 上午/下午, hours 1–7 read as afternoon.
 */
import { todoLocalDate, type TodoDeadline } from '@cindy/maker-shared/teammate-todo';

import { addDays, buildDeadline, nextMonday, weekdayIndex } from './todoDates';

export interface ParsedTodoWhen {
  /** The recognised text as the user typed it (shown in the dismiss label). */
  phrase: string;
  /** The title with the recognised text removed. */
  rest: string;
  deadline: TodoDeadline;
}

interface Hit {
  start: number;
  end: number;
}
interface DayHit extends Hit {
  /** Days from today, or a weekday resolved later. */
  offset?: number;
  weekday?: number;
  nextWeek?: boolean;
}
interface TimeHit extends Hit {
  time: string;
  /** No period word and no minutes: only a time when it sits right next to a day word. */
  bare?: boolean;
}

const ZH_WEEK = '(?:周|週|星期|礼拜|禮拜)';
const ZH_DAY = new RegExp(
  `(今天|明天|后天|後天|下${ZH_WEEK}[一二三四五六日天]|${ZH_WEEK}[一二三四五六日天])(?:之前|前)?`,
);
const ZH_TIME =
  /(?<!\d)(上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{2})(?!\d)|[点點](?!心)(?:钟|鐘)?(?:(半)|(\d{1,2})分?)?)/;
const ZH_WEEKDAYS = '日一二三四五六';

const EN_WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
const EN_FULL = Object.keys(EN_WEEKDAYS).filter((name) => name.endsWith('day'));
const EN_SHORT = Object.keys(EN_WEEKDAYS).filter((name) => !name.endsWith('day'));
// Full names stand alone; abbreviations (sat, sun, wed…) are ordinary words unless a preposition leads.
const EN_DAY = new RegExp(
  `\\b(?:(?:by|on)\\s+)?(today|tomorrow|(?:(next|this)\\s+)?(${EN_FULL.join('|')}))\\b` +
    `|\\b(?:by|on|this|(next))\\s+(${EN_SHORT.join('|')})\\b`,
  'i',
);
const EN_TIME_CLOCK = /(?<![\d:])(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?(?![\w:])/i;
const EN_TIME_MERIDIEM = /(?<![\d:])(?:at\s+)?(\d{1,2})\s*(am|pm)(?!\w)/i;

function clock(hour: number, minute: number): string | null {
  return hour > 23 || minute > 59
    ? null
    : `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function zhDay(text: string): DayHit | null {
  const match = ZH_DAY.exec(text);
  if (!match) return null;
  const word = match[1];
  const hit = { start: match.index, end: match.index + match[0].length };
  if (word === '今天') return { ...hit, offset: 0 };
  if (word === '明天') return { ...hit, offset: 1 };
  if (word === '后天' || word === '後天') return { ...hit, offset: 2 };
  const last = word.slice(-1);
  const weekday = ZH_WEEKDAYS.indexOf(last === '天' ? '日' : last);
  return { ...hit, weekday, nextWeek: word.startsWith('下') };
}

function zhTime(text: string): TimeHit | null {
  const match = ZH_TIME.exec(text);
  if (!match) return null;
  const [whole, period, hourText, minuteText, half, minuteAfter] = match;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : half ? 30 : minuteAfter ? Number(minuteAfter) : 0;
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
  else if (period === '中午' && hour <= 4) hour += 12;
  else if (!period && !minuteText && hour >= 1 && hour <= 7) hour += 12;
  const time = clock(hour, minute);
  const bare = !period && !minuteText && !half && !minuteAfter;
  return time ? { start: match.index, end: match.index + whole.length, time, bare } : null;
}

function enDay(text: string): DayHit | null {
  const match = EN_DAY.exec(text);
  if (!match) return null;
  const hit = { start: match.index, end: match.index + match[0].length };
  if (match[5])
    return { ...hit, weekday: EN_WEEKDAYS[match[5].toLowerCase()], nextWeek: Boolean(match[4]) };
  const word = match[1].toLowerCase();
  if (word === 'today') return { ...hit, offset: 0 };
  if (word === 'tomorrow') return { ...hit, offset: 1 };
  return {
    ...hit,
    weekday: EN_WEEKDAYS[match[3].toLowerCase()],
    nextWeek: match[2]?.toLowerCase() === 'next',
  };
}

function enTime(text: string): TimeHit | null {
  const clockMatch = EN_TIME_CLOCK.exec(text);
  const meridiemMatch = clockMatch ? null : EN_TIME_MERIDIEM.exec(text);
  const match = clockMatch ?? meridiemMatch;
  if (!match) return null;
  const meridiem = (clockMatch ? match[3] : match[2])?.toLowerCase();
  let hour = Number(match[1]);
  const minute = clockMatch ? Number(match[2]) : 0;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  const time = clock(hour, minute);
  return time ? { start: match.index, end: match.index + match[0].length, time } : null;
}

function resolveDate(day: DayHit | null, today: string): string {
  if (!day) return today;
  if (day.offset !== undefined) return addDays(today, day.offset);
  const weekday = day.weekday!;
  if (day.nextWeek) return addDays(nextMonday(today), (weekday + 6) % 7);
  return addDays(today, (weekday - weekdayIndex(today) + 7) % 7);
}

export function parseTodoWhen(
  text: string,
  now: Date,
  timeZone: string,
  locale: string,
): ParsedTodoWhen | null {
  const language = locale.split('-')[0].toLowerCase();
  if (language !== 'zh' && language !== 'en') return null;
  const day = language === 'zh' ? zhDay(text) : enDay(text);
  let time = language === 'zh' ? zhTime(text) : enTime(text);
  if (time?.bare) {
    const gap = !day
      ? null
      : time.start >= day.end
        ? text.slice(day.end, time.start)
        : text.slice(time.end, day.start);
    if (gap === null || !/^\s*$/.test(gap)) time = null;
  }
  if (!day && !time) return null;
  let today: string;
  try {
    today = todoLocalDate(now, timeZone);
  } catch {
    return null;
  }
  const hits = [day, time].filter((hit): hit is DayHit | TimeHit => hit !== null);
  hits.sort((a, b) => a.start - b.start);
  const pieces = hits.map((hit) => text.slice(hit.start, hit.end));
  const contiguous =
    hits.length === 1 || /^\s*$/.test(text.slice(hits[0].end, hits[1].start));
  const phrase = contiguous ? text.slice(hits[0].start, hits[hits.length - 1].end) : pieces.join(' ');
  let rest = '';
  let cursor = 0;
  for (const hit of hits) {
    rest += text.slice(cursor, hit.start);
    cursor = hit.end;
  }
  rest = (rest + text.slice(cursor)).replace(/\s+/g, ' ').trim();
  let date = resolveDate(day, today);
  if (!day && time) {
    // A time alone that has already passed today means the next one.
    const todayAt = buildDeadline(today, time.time, timeZone);
    if (todayAt.at && Date.parse(todayAt.at) < now.getTime()) date = addDays(today, 1);
  }
  return {
    phrase,
    rest,
    deadline: buildDeadline(date, time?.time, timeZone),
  };
}
