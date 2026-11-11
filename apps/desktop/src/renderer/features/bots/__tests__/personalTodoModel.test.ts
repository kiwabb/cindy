import { describe, expect, it } from 'vitest';
import type { TaskTag } from '@cindy/maker-shared';
import type { TodoDeadline } from '@cindy/maker-shared/teammate-todo';

import type { PersonalTodo } from '../../../../shared/personalTodo';

/**
 * 测试价值
 * - 生产入口与可观察结果：personalSections / personalTagChips / personalCounts / personalDueText，
 *   即「我的待办」页上各分组里出现哪些事项、顺序、各档计数，以及每行右侧的截止文字。
 * - Bug／规则依据：2026-11 个人待办改版（owner 批准的原型）第 1、3、4、6 条：分组与组内顺序、
 *   标签筛选只认目录里存在的标签、截止文字只补标题没说的、逾期「N 天」。
 * - 现有覆盖缺口：旧页面把个人事项转成伙伴待办再分组，没有优先级、标签、组内顺序，也没有截止文字的单测。
 * - 最小失败输入：同优先级一条有截止一条没有；标签 id 不在目录里；今天凌晨的 instant 已过期但相差 0 天。
 * - tier：unit（纯函数，注入时钟）。
 */
import {
  personalCounts,
  personalDueText,
  personalSections,
  personalTagChips,
  type PersonalListInput,
} from '../personalTodoModel';

const zone = 'Asia/Shanghai';
// Wednesday 2026-11-11, 12:00 in Shanghai.
const now = new Date('2026-11-11T04:00:00Z');
const day = (date: string): TodoDeadline => ({ kind: 'date', date, timeZone: zone });
const at = (iso: string, date = iso.slice(0, 10)): TodoDeadline => ({ kind: 'instant', date, at: iso, timeZone: zone });

let seq = 0;
function todo(id: string, patch: Partial<PersonalTodo> = {}): PersonalTodo {
  seq++;
  return {
    id, revision: 1, title: id, notes: '', deadline: null, status: 'open', deferredUntil: null,
    createdAt: `2026-11-0${(seq % 9) + 1}T00:00:00Z`, updatedAt: '2026-11-10T00:00:00Z',
    priority: 0, tagIds: [], reminder: 'default', ownership: 'self', source: 'manual', ...patch,
  };
}
const tag = (id: string, name: string, order: number): TaskTag => ({
  id, name, color: 'blue', favoriteOrder: null, sortOrder: order, revision: 1,
});
const catalog = [tag('work', 'Work', 0), tag('life', 'Life', 1)];

const items = [
  todo('overdue-p3', { priority: 3, deadline: day('2026-11-10'), tagIds: ['work'] }),
  todo('today-p3', { priority: 3, deadline: at('2026-11-11T09:30:00Z'), tagIds: ['work'] }),
  todo('today-p2', { priority: 2, deadline: at('2026-11-11T06:00:00Z'), tagIds: ['life'] }),
  todo('week-p0', { deadline: day('2026-11-13'), tagIds: ['ghost'] }),
  todo('none-p1', { priority: 1 }),
  todo('none-p2', { priority: 2 }),
  todo('snoozed', { deferredUntil: '2026-11-20T00:00:00Z' }),
  todo('finished', { status: 'done', completedAt: '2026-11-09T00:00:00Z' }),
  todo('finished-later', { status: 'done', completedAt: '2026-11-10T00:00:00Z' }),
];

const sections = (patch: Partial<PersonalListInput> = {}) =>
  personalSections({ items, view: 'open', grouping: 'due', order: 'priority', catalog, filter: { kind: 'all' }, now, ...patch })
    .map((section) => [section.id, section.items.map((item) => item.id)]);

describe('personal todo sections', () => {
  it('groups by deadline bucket with the higher priority first and keeps snoozed and done items out', () => {
    expect(sections()).toEqual([
      ['bucket:overdue', ['overdue-p3']],
      ['bucket:today', ['today-p3', 'today-p2']],
      ['bucket:week', ['week-p0']],
      ['bucket:none', ['none-p2', 'none-p1']],
    ]);
  });

  it('orders by earlier deadline, then priority, when asked', () => {
    expect(sections({ order: 'due' }).find(([id]) => id === 'bucket:today')?.[1]).toEqual(['today-p2', 'today-p3']);
  });

  it('breaks priority ties by the earlier deadline and puts items without one last', () => {
    const tied = [todo('no-date', { priority: 2 }), todo('late', { priority: 2, deadline: day('2026-12-01') }), todo('soon', { priority: 2, deadline: day('2026-11-14') })];
    const result = personalSections({ items: tied, view: 'open', grouping: 'none', order: 'priority', catalog, filter: { kind: 'all' }, now });
    expect(result[0].items.map((item) => item.id)).toEqual(['soon', 'late', 'no-date']);
  });

  it('groups by priority and by tag, treating a tag id missing from the catalog as untagged', () => {
    expect(sections({ grouping: 'priority' }).map(([id]) => id)).toEqual(['priority:3', 'priority:2', 'priority:1', 'priority:0']);
    expect(sections({ grouping: 'tag' })).toEqual([
      ['tag:work', ['overdue-p3', 'today-p3']],
      ['tag:life', ['today-p2']],
      ['tag:none', ['none-p2', 'none-p1', 'week-p0']],
    ]);
  });

  it('filters by a tag, by no tag, and ignores a filter on a tag that was deleted', () => {
    expect(sections({ grouping: 'none', filter: { kind: 'tag', id: 'life' } })).toEqual([['all', ['today-p2']]]);
    expect(sections({ grouping: 'none', filter: { kind: 'none' } })[0][1]).toEqual(['none-p2', 'none-p1', 'week-p0']);
    expect(sections({ grouping: 'none', filter: { kind: 'tag', id: 'deleted' } })[0][1]).toHaveLength(6);
  });

  it('lists snoozed items in one section and finished ones newest completion first', () => {
    expect(sections({ view: 'later' })).toEqual([['all', ['snoozed']]]);
    expect(sections({ view: 'done' })).toEqual([['all', ['finished-later', 'finished']]]);
  });

  it('counts each view and the tag chips from open items, keeping a selected empty tag', () => {
    expect(personalCounts(items, now)).toEqual({ open: 6, later: 1, done: 2 });
    const chips = personalTagChips(items, catalog, { kind: 'tag', id: 'life' }, now);
    expect(chips.all).toBe(6);
    expect(chips.none).toBe(3);
    expect(chips.tags.map((chip) => [chip.tag.id, chip.count])).toEqual([['work', 2], ['life', 1]]);
    const noLife = items.filter((item) => item.id !== 'today-p2');
    expect(personalTagChips(noLife, catalog, { kind: 'all' }, now).tags.map((chip) => chip.tag.id)).toEqual(['work']);
    expect(personalTagChips(noLife, catalog, { kind: 'tag', id: 'life' }, now).tags.map((chip) => [chip.tag.id, chip.count])).toEqual([['work', 2], ['life', 0]]);
  });
});

describe('personal due text', () => {
  const overdueLabel = (days: number) => `overdue:${days}`;
  const text = (deadline: TodoDeadline | null, locale: string, groupBucket?: Parameters<typeof personalDueText>[1]['groupBucket']) => {
    const result = personalDueText(deadline, { groupBucket, now, locale, overdueLabel });
    return { ...result, text: result.text.replace(/\s+/g, ' ') };
  };

  it.each([
    ['overdue by days', day('2026-11-08'), 'overdue', { text: 'overdue:3', overdue: true }, { text: 'overdue:3', overdue: true }],
    ['earlier today', at('2026-11-11T01:00:00Z'), 'overdue', { text: 'overdue:0', overdue: true }, { text: 'overdue:0', overdue: true }],
    ['today with a time', at('2026-11-11T09:30:00Z'), 'today', { text: '5:30 PM', overdue: false }, { text: 'Today 5:30 PM', overdue: false }],
    ['today, date only', day('2026-11-11'), 'today', { text: '', overdue: false }, { text: 'Today', overdue: false }],
    ['tomorrow', day('2026-11-12'), 'week', { text: 'Tomorrow', overdue: false }, { text: 'Tomorrow', overdue: false }],
    ['later this week with a time', at('2026-11-13T01:00:00Z'), 'week', { text: 'Fri 9:00 AM', overdue: false }, { text: 'Fri 9:00 AM', overdue: false }],
    ['next week', day('2026-11-16'), 'later', { text: 'Nov 16', overdue: false }, { text: 'Nov 16', overdue: false }],
    ['no deadline', null, 'none', { text: '', overdue: false }, { text: '', overdue: false }],
  ] as const)('%s', (_name, deadline, bucket, grouped, full) => {
    expect(text(deadline, 'en', bucket)).toEqual(grouped);
    expect(text(deadline, 'en')).toEqual(full);
  });

  it('follows the interface language instead of fixed words', () => {
    expect(text(at('2026-11-11T09:30:00Z'), 'zh-CN')).toEqual({ text: '今天 17:30', overdue: false });
    expect(text(day('2026-11-16'), 'zh-CN', 'later').text).toBe('11月16日');
    expect(text(day('2026-11-13'), 'zh-CN', 'week').text).toBe('周五');
  });

  it('adds the year only for a date in another year', () => {
    expect(text(day('2027-01-05'), 'en', 'later').text).toBe('Jan 5, 2027');
  });
});
