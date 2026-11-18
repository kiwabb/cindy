import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import { stringArrayParam } from './_array-param.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 个人待办(2026-11-10):用户自己的清单。
 * 数据在运行 Cindy 的这台电脑上、当前登录账号名下;宿主用同一个账号存储写入,
 * 桌面与手机界面随后刷新。工具不接受 botId、账号或设备参数。
 */

export interface PersonalTodoWire {
  id: string;
  revision: number;
  title: string;
  notes: string;
  deadline: unknown;
  status: 'open' | 'done';
  deferredUntil: string | null;
  priority?: number;
  tagIds?: string[];
  reminder?: string;
  subtasks?: Array<{ id: string; title: string; done: boolean; doneAt?: string }>;
  link?: { sessionId: string; deviceId?: string; botId?: string };
  /** Manual order on the host's scale (lower first); the tool reports `position` instead. */
  rank?: number;
  [key: string]: unknown;
}

export interface PersonalTodoCallbacks {
  (
    operation: 'list' | 'update' | 'reorder',
    input?: Record<string, unknown>,
  ): Promise<ControlResult<Record<string, unknown>, string>>;
}

/**
 * 多台电脑同步的管理(与桌面待办页同一组主进程动作)。status 返回本机角色与冲突清单。
 */
export interface PersonalTodoSyncCallbacks {
  (
    operation: 'status' | 'enable' | 'disable' | 'set-home' | 'resolve',
    input?: Record<string, unknown>,
  ): Promise<ControlResult<Record<string, unknown>, string>>;
}

/** 任务标签目录条目(同 list_task_tags 的 id / name / color)。 */
export interface PersonalTodoTagWire {
  id: string;
  name: string;
  color: string;
}

const deadline = z.object({
  kind: z.enum(['date', 'instant']),
  date: z.string().max(10).describe('YYYY-MM-DD,按 timeZone 的日历日。'),
  timeZone: z.string().max(100).describe('IANA 时区,如 Asia/Shanghai。'),
  at: z.string().max(80).optional().describe('kind=instant 时必填:带时区偏移的 ISO 时间。'),
});

const HINTS: Record<string, string> = {
  CONFLICT:
    '待办已被改动(版本不符,或同一 creationRequestId 已用于内容不同的新建)。先 list_personal_todos 取最新 revision 与内容,再基于最新内容重试;不要沿用旧 revision。',
  NOT_FOUND: '没有这条个人待办(可能已删除)。先 list_personal_todos 确认 id。',
  NOT_ENABLED: '这台电脑还没有开启待办同步。先用 set_personal_todo_sync 的 enable。',
  NOT_FOUND_CONFLICT: '没有这个冲突。先 get_personal_todo_sync 看当前冲突。',
  OWNER_CHANGED: '登录账号已切换或正在切换,本次未写入。让用户确认当前账号后重新查询再决定是否重试。',
};

/** 位置参数(update_personal_todo 与 reorder_personal_todos 共用):三选一,都不传就不动位置。 */
const placeShape = {
  moveTo: z.enum(['top', 'bottom']).optional().describe('放到整个清单的最前(top)或最后(bottom)。'),
  beforeId: z.string().min(1).max(128).optional().describe('放到这条待办的正前方(待办 id)。'),
  afterId: z.string().min(1).max(128).optional().describe('放到这条待办的正后方(待办 id)。'),
};
type PlaceArgs = { moveTo?: 'top' | 'bottom'; beforeId?: string; afterId?: string };

/** 把三个位置参数折成宿主的 place;同时给了多个返回 null(调用方报 INVALID_INPUT)。 */
function placeOf({ moveTo, beforeId, afterId }: PlaceArgs): Record<string, string> | undefined | null {
  const given = [moveTo, beforeId, afterId].filter((value) => value !== undefined).length;
  if (given > 1) return null;
  if (moveTo) return { to: moveTo };
  if (beforeId) return { before: beforeId };
  if (afterId) return { after: afterId };
  return undefined;
}

const PLACE_HINT = 'moveTo、beforeId、afterId 只能三选一。';

/** 期限的大致时刻,只用于 sort=due:没有期限的排最后。 */
function dueTime(deadline: unknown): number {
  const d = deadline as { kind?: string; date?: string; at?: string } | null | undefined;
  if (!d || typeof d.date !== 'string') return Infinity;
  const at = d.kind === 'instant' && d.at ? Date.parse(d.at) : Date.parse(`${d.date}T23:59:59Z`);
  return Number.isFinite(at) ? at : Infinity;
}

export function registerPersonalTodoTools(
  registry: XdtHelperToolRegistry,
  callback: PersonalTodoCallbacks,
  syncCallback?: PersonalTodoSyncCallbacks,
): void {
  const run = async (operation: 'list' | 'update' | 'reorder', input?: Record<string, unknown>) => {
    const result = await callback(operation, input);
    if (result.ok) return okPayload(result);
    return errorPayload(
      result.errorCode,
      HINTS[result.errorCode] ?? result.message,
    );
  };

  registry.register({
    name: 'list_personal_todos',
    category: 'todos',
    description:
      '列出用户本人的个人待办(仅本机、当前登录账号)。默认按用户的手动顺序返回(与待办页「手动排序」一致),每条带 position(在整个清单手动顺序里的序号,从 1 开始;筛选后序号不重排,可能不连续);sort=priority 改为高优先级在前、sort=due 改为期限近的在前(同级仍按手动顺序),position 不变。返回 id、revision、标题、备注、期限、状态、稍后到期时间、priority(0 无、1 低、2 中、3 高)、tagIds 与解析后的 tags(id/name/color)、reminder、subtasks(子任务清单 [{id,title,done,doneAt}],按顺序;doneAt=该步勾选的时间,未勾选或早于记录时间就已勾选的步骤没有)与 subtasksDone/subtasksTotal(完成进度)、link(关联的对话 {sessionId, deviceId?, botId?},没有关联就没有这个字段);顶层 tags 是可用的任务标签目录(与 list_task_tags 同一批 id),给待办打标签时从这里取 id;开了多台电脑同步时,顶层 sync 给出本机角色、主力电脑是否在线与待同步条数,副本上的 tags 是主力电脑的目录。修改前用它取最新 revision。view:open=未完成且未稍后、later=稍后中、done=已完成、all=全部;默认未完成含稍后。priority=只列优先级不低于该级别的待办;tagId=只列带该标签的待办。调整顺序用 update_personal_todo 的位置参数(单条)或 reorder_personal_todos(一批)。',
    inputShape: {
      view: z.enum(['open', 'later', 'done', 'all']).optional(),
      priority: z.number().int().min(0).max(3).optional(),
      tagId: z.string().trim().min(1).max(128).optional(),
      sort: z.enum(['manual', 'priority', 'due']).optional(),
    },
    handler: async ({ view, priority, tagId, sort }) => {
      const result = await callback('list');
      if (!result.ok) return errorPayload(result.errorCode, HINTS[result.errorCode] ?? result.message);
      const catalog = ((result.tags ?? []) as PersonalTodoTagWire[]).map(({ id, name, color }) => ({ id, name, color }));
      const byId = new Map(catalog.map((tag) => [tag.id, tag]));
      const tagsNote = typeof result.tagsError === 'string' ? result.tagsError : undefined;
      // The host returns the whole list in manual order; position is the place in that order.
      const all = ((result.items ?? []) as PersonalTodoWire[]).map((todo, index) => ({ todo, position: index + 1 }));
      const filtered = all.filter(({ todo }) => {
        if (priority !== undefined && (todo.priority ?? 0) < priority) return false;
        if (tagId !== undefined && !(todo.tagIds ?? []).includes(tagId)) return false;
        const later = todo.status === 'open' && !!todo.deferredUntil && Date.parse(todo.deferredUntil) > Date.now();
        if (view === 'all') return true;
        if (view === 'done') return todo.status === 'done';
        if (view === 'later') return later;
        if (view === 'open') return todo.status === 'open' && !later;
        return todo.status === 'open';
      });
      if (sort === 'priority')
        filtered.sort((a, b) => (b.todo.priority ?? 0) - (a.todo.priority ?? 0) || a.position - b.position);
      else if (sort === 'due')
        filtered.sort((a, b) => dueTime(a.todo.deadline) - dueTime(b.todo.deadline) || a.position - b.position);
      const items = filtered.map(({ todo: { rank: _rank, ...todo }, position }) => ({
        ...todo,
        position,
        priority: todo.priority ?? 0,
        tagIds: todo.tagIds ?? [],
        reminder: todo.reminder ?? 'default',
        tags: (todo.tagIds ?? []).flatMap((id) => byId.get(id) ?? []),
        subtasks: todo.subtasks ?? [],
        subtasksDone: (todo.subtasks ?? []).filter((step) => step.done).length,
        subtasksTotal: (todo.subtasks ?? []).length,
      }));
      return okPayload({
        items,
        total: items.length,
        tags: catalog,
        ...(tagsNote ? { tagsNote } : {}),
        ...(result.sync ? { sync: result.sync } : {}),
        scope: 'local-current-account',
      });
    },
  });

  registry.register({
    name: 'update_personal_todo',
    category: 'todos',
    description:
      '新建或修改用户本人的个人待办(仅本机、当前登录账号)。新建:不传 id,传 title 和 creationRequestId(1-80 位字母数字、_ 或 -);重试同一次新建必须复用同一个 creationRequestId 才不会重复,内容改了就换新 id。修改:传 id 与最近一次 list_personal_todos 的 expectedRevision,可改 title、notes、deadline(null 清除)、priority(0 无、1 低、2 中、3 高)、tagIds(标签 id 数组,整体替换,最多 16 个,[] 清空;id 取自 list_personal_todos 的 tags,通常只设一个)、subtasks(子任务清单,整体替换,最多 50 步:数组元素 {id?, title, done?};要勾选、改名、删除或调整顺序,先取最近一次 list_personal_todos 的 subtasks,改好后连同 expectedRevision 整个清单一起发送;已有步骤保留原 id,新步骤不带 id;勾选时间由系统记录(已勾的保留原时间,新勾的记为本次修改时间),不必传;[] 清空)、reminder(期限提醒:default=到期时刻,仅日期期限为当天 09:00;off=不提醒;before-15m/before-1h/before-1d=提前 15 分钟/1 小时/1 天)、link(关联一场对话:{sessionId, deviceId?, botId?},用户点待办行尾的按钮就打开这场对话;sessionId=任务 id,deviceId=对话不在这台电脑上时它所在电脑的 id,botId=伙伴 id;null 取消关联;只在要设置或修改时传),或用 operation 完成(complete)、重开(reopen)、稍后(later,需 until=未来的 ISO 时间)、恢复稍后(restore)、删除(delete)。冲突时先重新列出再基于最新内容重试。多台电脑同步中,在副本电脑上修改会先记在本机并返回 sync:synced(主力电脑已接收)或 sync:pending(待主力电脑接收,不是失败)。位置(手动顺序):新建默认排在清单最后,所以按先后依次新建的一批待办自然就是这个顺序;要放到别处,新建或修改时传 moveTo(top/bottom)、beforeId 或 afterId 其中一个(修改时可以只传 id、expectedRevision 与位置参数来单独移动)。移动会让这条(偶尔还有其他条)的 revision 加一,之后的修改先重新 list。一批待办要排成指定顺序时用 reorder_personal_todos 一次完成。',
    inputShape: {
      id: z.string().max(128).optional(),
      creationRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      title: z.string().min(1).max(300).optional(),
      notes: z.string().max(4000).optional(),
      deadline: deadline.nullable().optional(),
      priority: z.number().int().min(0).max(3).optional(),
      tagIds: stringArrayParam(z.array(z.string().trim().min(1).max(128)).max(16)).optional(),
      reminder: z.enum(['default', 'off', 'before-15m', 'before-1h', 'before-1d']).optional(),
      subtasks: z
        .array(z.object({ id: z.string().max(128).optional(), title: z.string().min(1).max(300), done: z.boolean().optional() }))
        .max(50)
        .optional(),
      link: z
        .object({
          sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          deviceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
          botId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
        })
        .strict()
        .nullable()
        .optional(),
      operation: z.enum(['complete', 'reopen', 'delete', 'later', 'restore']).optional(),
      until: z.string().max(80).optional(),
      ...placeShape,
    },
    handler: async ({ moveTo, beforeId, afterId, ...input }) => {
      const place = placeOf({ moveTo, beforeId, afterId });
      if (place === null) return errorPayload('INVALID_INPUT', PLACE_HINT);
      return run('update', { ...input, ...(place ? { place } : {}) });
    },
  });

  registry.register({
    name: 'reorder_personal_todos',
    category: 'todos',
    description:
      '一次调整一批个人待办的手动顺序(仅本机、当前登录账号;待办页选「手动排序」时就按这个顺序显示)。ids=按想要的先后排好的待办 id(1-200 个,不重复),它们会连成一段、按这个顺序排列;不在 ids 里的待办相对顺序不变。这一段放在哪:moveTo=top/bottom 放到整个清单最前/最后,beforeId/afterId 放到某条不在 ids 里的待办前/后(三选一);都不传就从 ids 里当前最靠前的那条的位置开始。要把整个清单重排,就把全部 id 按新顺序传进来。不需要 revision;返回 todos=顺序值变了的待办(revision 已加一,之后修改它们先重新 list),顺序本来就对时为空。多台电脑同步的副本上同样返回 sync:synced 或 sync:pending。示例:{ids:["a","b","c"], moveTo:"top"} 把 a、b、c 依次放到最前。',
    inputShape: {
      ids: stringArrayParam(z.array(z.string().min(1).max(128)).min(1).max(200)),
      ...placeShape,
    },
    handler: async ({ ids, moveTo, beforeId, afterId }) => {
      const place = placeOf({ moveTo, beforeId, afterId });
      if (place === null) return errorPayload('INVALID_INPUT', PLACE_HINT);
      return run('reorder', { ids, ...(place ? { place } : {}) });
    },
  });

  if (!syncCallback) return;
  const runSync = async (operation: Parameters<PersonalTodoSyncCallbacks>[0], input?: Record<string, unknown>) => {
    const result = await syncCallback(operation, input);
    if (result.ok) return okPayload(result);
    return errorPayload(result.errorCode, HINTS[result.errorCode] ?? result.message);
  };

  registry.register({
    name: 'get_personal_todo_sync',
    category: 'todos',
    description:
      '读个人待办的多台电脑同步状态:role(off 未开启 / home 这台是主力电脑 / replica 这台是副本)、homeName(主力电脑名)、homeOnline、pending(这台改了但主力电脑还没接收的条数)、lastError(REMOTE_DISABLED=主力电脑没开远程控制),以及 conflicts:主力电脑拒绝的修改(id 冲突标识、code、todoId;同一条待办可能有多条冲突,按先后处理;新建被拒时带 draft 草稿)。',
    inputShape: {},
    handler: () => runSync('status'),
  });

  registry.register({
    name: 'set_personal_todo_sync',
    category: 'todos',
    description:
      '开启或关闭个人待办的多台电脑同步,或把这台电脑设为主力电脑。action:enable=开启(同账号已有主力电脑则这台成为副本并先带上本机已有待办,否则这台成为主力电脑);disable=关闭(本机留着当前这份清单,不再同步);set_home=把这台设为主力电脑(仅副本可用;旧主力电脑在线时先交接,离线则以本机为准接管)。主力电脑是唯一写入者,提醒只在主力电脑上触发。',
    inputShape: { action: z.enum(['enable', 'disable', 'set_home']) },
    handler: ({ action }) => runSync(action === 'set_home' ? 'set-home' : action),
  });

  registry.register({
    name: 'resolve_personal_todo_conflict',
    category: 'todos',
    description:
      '处理一条同步冲突(先 get_personal_todo_sync 取冲突的 id)。choice:mine=用我的版本(以最新版本为基础重新提交;新建被拒的会换新的 creationRequestId 重新提交);theirs=保留电脑上的(丢弃我这次修改)。',
    inputShape: { conflictId: z.string().min(1).max(64), choice: z.enum(['mine', 'theirs']) },
    handler: ({ conflictId, choice }) => runSync('resolve', { conflictId, choice }),
  });
}
