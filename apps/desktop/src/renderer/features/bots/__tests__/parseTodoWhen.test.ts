import { describe, expect, it } from 'vitest';
import { validateTodoDeadline } from '@cindy/maker-shared/teammate-todo';

/**
 * 测试价值
 * - 生产入口与可观察结果：parseTodoWhen(text, now, timeZone, locale)，即新增待办输入框里「明天下午3点…」
 *   被识别成的截止（date / instant）、被摘掉的短语和剩下的标题。
 * - Bug／规则依据：2026-11 个人待办改版（owner 批准的原型）第 8 条：日期短语本地识别；输出必须通过
 *   validateTodoDeadline，instant 的 `at` 在 timeZone 里的本地日期等于 `date`。
 * - 现有覆盖缺口：新模块，没有相邻测试。
 * - 最小失败输入：时区不是系统时区时，用系统时区拼 `${date}T${time}` 会得到错的 instant；
 *   「买3点心」不能被当成 3 点。
 * - tier：unit（纯函数，注入时钟与时区）。
 */
import { parseTodoWhen } from '../parseTodoWhen';

// 2026-11-11 is a Wednesday in every zone used below at the chosen instants.
const shanghaiNoon = new Date('2026-11-11T04:00:00Z');
const newYorkMorning = new Date('2026-11-11T15:00:00Z');

function run(text: string, now: Date, zone: string, locale: string) {
  const parsed = parseTodoWhen(text, now, zone, locale);
  if (parsed) expect(() => validateTodoDeadline(parsed.deadline)).not.toThrow();
  return parsed;
}

describe('parseTodoWhen', () => {
  it.each([
    ['明天下午3点交季度报告', '明天下午3点', '交季度报告', { kind: 'instant', date: '2026-11-12', at: '2026-11-12T07:00:00.000Z' }],
    ['周五提交报销', '周五', '提交报销', { kind: 'date', date: '2026-11-13' }],
    ['周三整理', '周三', '整理', { kind: 'date', date: '2026-11-11' }],
    ['周一开会', '周一', '开会', { kind: 'date', date: '2026-11-16' }],
    ['下周一开会', '下周一', '开会', { kind: 'date', date: '2026-11-16' }],
    ['下星期日聚餐', '下星期日', '聚餐', { kind: 'date', date: '2026-11-22' }],
    ['星期天爬山', '星期天', '爬山', { kind: 'date', date: '2026-11-15' }],
    ['后天寄快递', '后天', '寄快递', { kind: 'date', date: '2026-11-13' }],
    ['晚上8点半复盘', '晚上8点半', '复盘', { kind: 'instant', date: '2026-11-11', at: '2026-11-11T12:30:00.000Z' }],
    ['中午12点吃饭', '中午12点', '吃饭', { kind: 'instant', date: '2026-11-11', at: '2026-11-11T04:00:00.000Z' }],
    ['10:30站会', '10:30', '站会', { kind: 'instant', date: '2026-11-11', at: '2026-11-11T02:30:00.000Z' }],
    ['今天 5点10分 取件', '今天 5点10分', '取件', { kind: 'instant', date: '2026-11-11', at: '2026-11-10T21:10:00.000Z' }],
  ])('recognises %s in Shanghai', (text, phrase, rest, expected) => {
    const parsed = run(text, shanghaiNoon, 'Asia/Shanghai', 'zh-CN');
    expect(parsed).toMatchObject({ phrase, rest, deadline: { ...expected, timeZone: 'Asia/Shanghai' } });
  });

  it.each([
    ['call mom tomorrow at 3pm', 'tomorrow at 3pm', 'call mom', { kind: 'instant', date: '2026-11-12', at: '2026-11-12T20:00:00.000Z' }],
    ['review next fri', 'next fri', 'review', { kind: 'date', date: '2026-11-20' }],
    ['Monday standup 9:30', 'Monday 9:30', 'standup', { kind: 'instant', date: '2026-11-16', at: '2026-11-16T14:30:00.000Z' }],
    ['lunch 12pm', '12pm', 'lunch', { kind: 'instant', date: '2026-11-11', at: '2026-11-11T17:00:00.000Z' }],
    ['backup 12am', '12am', 'backup', { kind: 'instant', date: '2026-11-11', at: '2026-11-11T05:00:00.000Z' }],
    ['pay rent today', 'today', 'pay rent', { kind: 'date', date: '2026-11-11' }],
  ])('recognises "%s" in New York', (text, phrase, rest, expected) => {
    const parsed = run(text, newYorkMorning, 'America/New_York', 'en');
    expect(parsed).toMatchObject({ phrase, rest, deadline: { ...expected, timeZone: 'America/New_York' } });
  });

  it('counts "today" in the deadline zone, not the system zone', () => {
    // 03:00Z is already Wednesday in Shanghai but still Tuesday evening in Los Angeles.
    const now = new Date('2026-11-11T03:00:00Z');
    expect(run('明天下午3点', now, 'America/Los_Angeles', 'zh-CN')?.deadline).toMatchObject({
      date: '2026-11-11',
      at: '2026-11-11T23:00:00.000Z',
    });
    expect(run('明天', now, 'Asia/Shanghai', 'zh-CN')?.deadline.date).toBe('2026-11-12');
  });

  it('falls back to the date when the wall time does not exist in the zone', () => {
    const parsed = run('明天2:30', new Date('2026-03-07T17:00:00Z'), 'America/New_York', 'zh-CN');
    expect(parsed?.deadline).toMatchObject({ kind: 'date', date: '2026-03-08' });
  });

  it.each([
    ['买3点心', 'zh-CN'],
    ['整理桌面', 'zh-CN'],
    ['25点开会', 'zh-CN'],
    ['ship it', 'en'],
    ['明天交报告', 'ja'],
    ['tomorrow call', 'de'],
  ])('finds nothing in %s (%s)', (text, locale) => {
    expect(parseTodoWhen(text, shanghaiNoon, 'Asia/Shanghai', locale)).toBeNull();
  });

  it('recognises Traditional Chinese and classical Chinese interface locales as Chinese', () => {
    expect(parseTodoWhen('明天交', shanghaiNoon, 'Asia/Shanghai', 'zh-TW')?.deadline.date).toBe('2026-11-12');
    expect(parseTodoWhen('明天交', shanghaiNoon, 'Asia/Shanghai', 'zh-Hant-x-lzh')?.deadline.date).toBe('2026-11-12');
  });
});
