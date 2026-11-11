import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { TeammateTodosView } from '../../../src/renderer/features/bots/TeammateTodosView';
import { queryTodoItems, todoLocalDate, type TeammateTodo, type TodoListQuery } from '@cindy/maker-shared/teammate-todo';
import { TASK_TAG_COLORS, type TaskTag } from '@cindy/maker-shared';
import type { PersonalTodo } from '../../../src/shared/personalTodo';

// Roster and cloud hooks are replaced at build time (ui-page.mjs `stubs`); the page, the local and
// device-link todo reads, filters, tooltips, theme and translations are the production code.

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (offset: number) => {
  const date = new Date(todoLocalDate(new Date(), zone) + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const deadline = (offset: number) => ({ kind: 'date' as const, date: day(offset), timeZone: zone });
// 本周还剩几天：今天是周日时「本周」段为空，取明天落到「更晚」也照样能看。
const daysToSunday = (7 - new Date(day(0) + 'T12:00:00Z').getUTCDay()) % 7;

function todo(id: string, title: string, patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id, revision: 1, key: id, origin: 'assigned', title, progress: '', outcome: '', value: '', next: null,
    sources: [{ kind: 'conversation', id: `c:${id}`, label: '' }], associations: [], status: 'open',
    createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-11-01T01:00:00Z', sourceDeadline: null,
    deadlineCandidate: null, suggestedDate: null, decision: null, history: [], action: null, ...patch,
  };
}

function local(caseName: string): TeammateTodo[] {
  if (caseName === 'empty') return [];
  return [
    todo('c1', '交 10 月报销单', {
      sources: [{ kind: 'mail', id: 'm1', label: '财务部 · 报销截止提醒' }],
      sourceDeadline: deadline(-3), deadlineOverride: { value: deadline(-1) },
      next: { kind: 'decide', label: '先交已有发票还是等补开', instruction: '还有两张发票没开出来。是先把已有的交上去，还是等齐了一起交？' },
    }),
    todo('c2', '回复张雯，确认下周一评审会时间', {
      origin: 'discovered', sources: [{ kind: 'mail', id: 'm2', label: '张雯 · 关于下周一的评审会' }],
      sourceDeadline: deadline(0),
      next: { kind: 'advance', label: '起草回复', instruction: '按你上周说的下周一上午 10 点有空，起草一封确认回复给张雯。' },
    }),
    todo('c3', '预约牙医复诊', { suggestedDate: day(4), next: { kind: 'advance', label: '打电话预约', instruction: '工作日上午打诊所电话。' } }),
    todo('c4', '换新的办公椅', { origin: 'discovered', decision: { kind: 'later', until: new Date(Date.now() + 9 * 86_400_000).toISOString() } }),
    todo('c5', '交 Q3 OKR 自评', { status: 'done', history: [{ summary: '已在 HR 系统提交', at: new Date(Date.now() - 2 * 86_400_000).toISOString() }] }),
  ];
}

function remote(caseName: string): TeammateTodo[] {
  if (caseName === 'empty') return [];
  return [
    todo('d1', '审阅 kb-extract 的合并请求', {
      origin: 'discovered', sources: [{ kind: 'github', id: 'g1', label: 'kb-extract!12' }],
      sourceDeadline: deadline(Math.max(1, daysToSunday)),
      next: { kind: 'decide', label: '合并还是先补测试', instruction: '' },
    }),
    todo('d2', '升级 Electron 到 38', {
      sources: [{ kind: 'task', id: 't1', label: '桌面端依赖升级' }], sourceDeadline: deadline(8),
      next: { kind: 'advance', label: '先在分支上跑一遍测试', instruction: '' },
    }),
    todo('d3', '整理 MES 报表复刻的技能文档', { next: { kind: 'advance', label: '补上参数定义那一节', instruction: '' } }),
  ];
}

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
    priority: 0, tagIds: [], reminder: 'default', ownership: 'self', source: 'manual', ...patch,
  };
}
function personal(caseName: string): PersonalTodo[] {
  if (caseName === 'personal-row')
    return [mine('unit-personal-row', '[fixture] Personal row — layout only', { notes: 'Unit fixture, no account data or writes.' })];
  if (caseName !== 'personal') return [];
  return [
    mine('p1', '提交季度报销单', { priority: 3, tagIds: ['work'], deadline: deadline(-1) }),
    mine('p2', '准备周会材料', { priority: 3, tagIds: ['work'], deadline: instant(0, 17, 30), notes: '数据截止到周三，附两张对比图' }),
    mine('p3', '回复供应商报价邮件', { priority: 2, tagIds: ['work'], deadline: instant(0, 14) }),
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

mountPage({
  route: '/bots/todos',
  host: (ctx) => ({
    localDb: {
      personalTodos: { list: async () => personal(ctx.case), update: forbid('personalTodos.update'), onChanged: subscription('personalTodos') },
      taskTags: {
        execute: async () => ({ tags: TAGS, sessions: [], supportedColors: [...TASK_TAG_COLORS] }),
        onChanged: subscription('taskTags'),
      },
      bots: { todos: {
        list: async () => ({ items: local(ctx.case), version: 1 }),
        update: forbid('todos.update'),
        dailyCheck: forbid('todos.dailyCheck'),
      } },
    },
    maker: { onBotWorkbenchChanged: subscription('todos') },
    routines: { onChanged: subscription('routines') },
    deviceLink: {
      invoke: async (deviceId: string, _channel: string, [request]: [{ query: string }]) => {
        if (deviceId !== 'mini') throw new Error(`offline computer ${deviceId} must not be read`);
        return { blocks: [{ primitive: 'teammate-todos', data: queryTodoItems(remote(ctx.case), JSON.parse(request.query) as TodoListQuery) }] };
      },
      onRemotePush: subscription('remote'),
    },
  }),
  render: () => (
    <AppFrame>
      <TeammateTodosView />
    </AppFrame>
  ),
});
