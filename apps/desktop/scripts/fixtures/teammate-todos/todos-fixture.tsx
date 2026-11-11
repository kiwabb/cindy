import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { TeammateTodosView } from '../../../src/renderer/features/bots/TeammateTodosView';
import { todoLocalDate } from '@cindy/maker-shared/teammate-todo';
import { TASK_TAG_COLORS, type TaskTag } from '@cindy/maker-shared';
import type { PersonalTodo } from '../../../src/shared/personalTodo';

// The page, the personal todo read, the task-tag cache, menus, tooltips, theme and translations are
// the production code; only the account generation hook is replaced at build time (ui-page.mjs `stubs`).

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (offset: number) => {
  const date = new Date(todoLocalDate(new Date(), zone) + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const deadline = (offset: number) => ({ kind: 'date' as const, date: day(offset), timeZone: zone });
// 本周还剩几天：今天是周日时「本周」段为空，取明天落到「更晚」也照样能看。
const daysToSunday = (7 - new Date(day(0) + 'T12:00:00Z').getUTCDay()) % 7;

// Personal todos are fixture data only: no account, no writes (`update` is forbidden below).
const tag = (id: string, name: string, color: TaskTag['color'], sortOrder: number): TaskTag => ({
  id, name, color, favoriteOrder: null, sortOrder, revision: 1, nameCustomized: true,
});
const TAGS = [tag('work', '工作', 'blue', 0), tag('life', '生活', 'green', 1), tag('study', '学习', 'purple', 2)];
const instant = (offset: number, hour: number, minute = 0) => {
  const date = day(offset);
  const at = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  return { kind: 'instant' as const, date, at: at.toISOString(), timeZone: zone };
};
function mine(id: string, title: string, patch: Partial<PersonalTodo> = {}): PersonalTodo {
  return {
    id, revision: 1, title, notes: '', deadline: null, status: 'open', deferredUntil: null,
    createdAt: `2026-11-0${Number(id.replace(/\D/g, '')) % 9 + 1}T08:00:00Z`, updatedAt: '2026-11-10T08:00:00Z',
    priority: 0, tagIds: [], reminder: 'default', subtasks: [], ownership: 'self', source: 'manual', ...patch,
  };
}
function personal(caseName: string): PersonalTodo[] {
  if (caseName === 'personal-row')
    return [mine('unit-personal-row', '[fixture] Personal row — layout only', { notes: 'Unit fixture, no account data or writes.' })];
  if (caseName === 'empty') return [];
  return [
    mine('p1', '提交季度报销单', { priority: 3, tagIds: ['work'], deadline: deadline(-1) }),
    mine('p2', '准备周会材料', { priority: 3, tagIds: ['work'], deadline: instant(0, 17, 30), notes: '数据截止到周三，附两张对比图', subtasks: [
      { id: 'a1', title: '汇总各部门数据', done: true },
      { id: 'a2', title: '制作两张对比图', done: true },
      { id: 'a3', title: '和负责人确认结论后再发给全体参会人员，并把最终版本放进共享目录', done: false },
      { id: 'a4', title: '打印会议材料', done: false },
    ] }),
    mine('p3', '回复供应商报价邮件', { priority: 2, tagIds: ['work'], deadline: instant(0, 14), subtasks: [
      { id: 'b1', title: '核对报价单', done: true },
      { id: 'b2', title: '确认交期', done: false },
      { id: 'b3', title: '回复邮件', done: false },
    ] }),
    mine('p4', '预约体检', { priority: 1, tagIds: ['life'], deadline: deadline(0) }),
    mine('p5', '整理第三季度客户反馈', { deadline: deadline(Math.max(1, daysToSunday)) }),
    mine('p6', '续费个人域名', { priority: 2, tagIds: ['life'], deadline: deadline(1) }),
    mine('p7', '读完架构笔记第 3 章', { priority: 1, tagIds: ['study'], deadline: deadline(9) }),
    mine('p8', '买咖啡豆', { tagIds: ['life'] }),
    mine('p9', '整理桌面文件', { tagIds: ['gone'] }),
    mine('p10', '更换护照', { priority: 1, tagIds: ['life'], deferredUntil: new Date(Date.now() + 14 * 86_400_000).toISOString() }),
    mine('p11', '更新简历', { status: 'done', completedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    mine('p12', '寄回样品', { status: 'done', completedAt: new Date(Date.now() - 86_400_000).toISOString() }),
  ];
}

// Multi-computer sync states (fixture data; every action is forbidden).
const SYNC_CASES = ['sync-home', 'sync-pending', 'sync-offline', 'sync-remote-off', 'sync-conflict-row', 'sync-conflict-draft'];
function syncStatus(caseName: string) {
  const base = { role: 'replica' as const, homeName: 'Studio-Mac', homeOnline: true, pending: 0, conflicts: 0, tags: TAGS };
  if (caseName === 'sync-home') return { ...base, role: 'home' as const, homeName: undefined };
  if (caseName === 'sync-pending') return { ...base, pending: 3 };
  if (caseName === 'sync-offline') return { ...base, homeOnline: false, pending: 1 };
  if (caseName === 'sync-remote-off') return { ...base, pending: 1, lastError: 'REMOTE_DISABLED' };
  if (caseName === 'sync-conflict-row') return { ...base, conflicts: 1 };
  return { ...base, conflicts: 1 };
}
function syncConflicts(caseName: string) {
  if (caseName === 'sync-conflict-row') return [{ sequence: 1, code: 'CONFLICT', todoId: 'p2' }];
  return [{ sequence: 2, code: 'NOT_FOUND', draft: { title: '订会议室并通知参会人', priority: 2, tagIds: ['work'], deadline: deadline(1) } }];
}
const syncApi = (caseName: string) =>
  SYNC_CASES.includes(caseName)
    ? {
        sync: {
          status: async () => syncStatus(caseName),
          conflicts: async () => syncConflicts(caseName),
          enable: forbid('sync.enable'),
          disable: forbid('sync.disable'),
          setAsHome: forbid('sync.setAsHome'),
          resolve: forbid('sync.resolve'),
          onChanged: subscription('personalTodosSync'),
        },
      }
    : {};

mountPage({
  route: '/bots/todos',
  host: (ctx) => ({
    localDb: {
      personalTodos: { list: async () => personal(ctx.case), update: forbid('personalTodos.update'), onChanged: subscription('personalTodos'), ...syncApi(ctx.case) },
      taskTags: {
        execute: async () => ({ tags: TAGS, sessions: [], supportedColors: [...TASK_TAG_COLORS] }),
        onChanged: subscription('taskTags'),
      },
    },
    maker: { onBotWorkbenchChanged: subscription('todos') },
    routines: { onChanged: subscription('routines') },
  }),
  render: () => (
    <AppFrame>
      <TeammateTodosView />
    </AppFrame>
  ),
});
