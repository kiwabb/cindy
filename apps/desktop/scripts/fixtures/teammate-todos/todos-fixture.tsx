import { AppFrame, forbid, mountPage } from '../../ui-page/harness';
import { TeammateTodosView } from '../../../src/renderer/features/bots/TeammateTodosView';
import { todoLocalDate } from '@cindy/maker-shared/teammate-todo';
import type { PersonalTodo } from '../../../src/shared/personalTodo';

// Auth hook is replaced at build time (ui-page.mjs `stubs`); the page, the personal todo read, sections,
// views, theme and translations are the production code. Todos below are unit-fixture data, no account data.

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (offset: number) => {
  const date = new Date(todoLocalDate(new Date(), zone) + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const deadline = (offset: number) => ({ kind: 'date' as const, date: day(offset), timeZone: zone });
// 本周还剩几天：今天是周日时「本周」段为空，取明天落到「更晚」也照样能看。
const daysToSunday = (7 - new Date(day(0) + 'T12:00:00Z').getUTCDay()) % 7;

function todo(id: string, title: string, patch: Partial<PersonalTodo> = {}): PersonalTodo {
  return {
    id, revision: 1, title, notes: '', deadline: null, status: 'open', deferredUntil: null,
    createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-11-01T01:00:00Z', ownership: 'self', source: 'manual', ...patch,
  };
}

function items(caseName: string): PersonalTodo[] {
  if (caseName === 'empty') return [];
  if (caseName === 'personal-row')
    return [todo('unit-personal-row', '[fixture] Personal row — layout only', { notes: 'Unit fixture, no account data or writes.' })];
  return [
    todo('c1', '交 10 月报销单', { deadline: deadline(-1) }),
    todo('c2', '回复张雯，确认下周一评审会时间', { deadline: deadline(0) }),
    todo('c3', '预约牙医复诊'),
    todo('c4', '换新的办公椅', { deferredUntil: new Date(Date.now() + 9 * 86_400_000).toISOString() }),
    todo('c5', '审阅 kb-extract 的合并请求', { deadline: deadline(Math.max(1, daysToSunday)) }),
    todo('c6', '升级 Electron 到 38', { deadline: deadline(8) }),
    todo('c7', '交 Q3 OKR 自评', { status: 'done', completedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
  ];
}

mountPage({
  route: '/bots/todos',
  host: (ctx) => ({
    localDb: { personalTodos: { list: async () => items(ctx.case), update: forbid('personalTodos.update') } },
  }),
  render: () => (
    <AppFrame>
      <TeammateTodosView />
    </AppFrame>
  ),
});
