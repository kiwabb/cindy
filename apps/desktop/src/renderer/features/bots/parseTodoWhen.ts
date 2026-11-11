/**
 * Recognises a date phrase in the title being typed in the composer. Local and deterministic:
 * no model call. Only Chinese and English phrases are recognised; every other locale returns null.
 *
 * Weeks run Monday to Sunday. A bare weekday means its next occurrence (today included);
 * "next <weekday>" / 下周X means that weekday of the following week. A time alone means today.
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
}

const ZH_DAY =
  /(今天|明天|后天|下(?:周|星期)[一二三四五六日天]|(?:周|星期)[一二三四五六日天])/;
const ZH_TIME =
  /(?<!\d)(上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{2})(?!\d)|点(?!心)钟?(?:(半)|(\d{1,2})分?)?)/;
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
const EN_DAY = new RegExp(
  `\\b(today|tomorrow|(?:(next)\\s+)?(${Object.keys(EN_WEEKDAYS).join('|')}))\\b`,
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
  const hit = { start: match.index, end: match.index + word.length };
  if (word === '今天') return { ...hit, offset: 0 };
  if (word === '明天') return { ...hit, offset: 1 };
  if (word === '后天') return { ...hit, offset: 2 };
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
  const time = clock(hour, minute);
  return time ? { start: match.index, end: match.index + whole.length, time } : null;
}

function enDay(text: string): DayHit | null {
  const match = EN_DAY.exec(text);
  if (!match) return null;
  const hit = { start: match.index, end: match.index + match[0].length };
  const word = match[1].toLowerCase();
  if (word === 'today') return { ...hit, offset: 0 };
  if (word === 'tomorrow') return { ...hit, offset: 1 };
  return { ...hit, weekday: EN_WEEKDAYS[match[3].toLowerCase()], nextWeek: Boolean(match[2]) };
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
  const time = language === 'zh' ? zhTime(text) : enTime(text);
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
  return {
    phrase,
    rest,
    deadline: buildDeadline(resolveDate(day, today), time?.time, timeZone),
  };
}
