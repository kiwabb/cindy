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
  subtasks?: Array<{ id: string; title: string; done: boolean }>;
  [key: string]: unknown;
}

export interface PersonalTodoCallbacks {
  (
    operation: 'list' | 'update',
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
  OWNER_CHANGED: '登录账号已切换或正在切换,本次未写入。让用户确认当前账号后重新查询再决定是否重试。',
};

export function registerPersonalTodoTools(
  registry: XdtHelperToolRegistry,
  callback: PersonalTodoCallbacks,
): void {
  const run = async (operation: 'list' | 'update', input?: Record<string, unknown>) => {
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
      '列出用户本人的个人待办(仅本机、当前登录账号)。返回 id、revision、标题、备注、期限、状态、稍后到期时间、priority(0 无、1 低、2 中、3 高)、tagIds 与解析后的 tags(id/name/color)、reminder、subtasks(子任务清单 [{id,title,done}],按顺序)与 subtasksDone/subtasksTotal(完成进度);顶层 tags 是可用的任务标签目录(与 list_task_tags 同一批 id),给待办打标签时从这里取 id。修改前用它取最新 revision。view:open=未完成且未稍后、later=稍后中、done=已完成、all=全部;默认未完成含稍后。priority=只列优先级不低于该级别的待办;tagId=只列带该标签的待办。',
    inputShape: {
      view: z.enum(['open', 'later', 'done', 'all']).optional(),
      priority: z.number().int().min(0).max(3).optional(),
      tagId: z.string().trim().min(1).max(128).optional(),
    },
    handler: async ({ view, priority, tagId }) => {
      const result = await callback('list');
      if (!result.ok) return errorPayload(result.errorCode, HINTS[result.errorCode] ?? result.message);
      const catalog = ((result.tags ?? []) as PersonalTodoTagWire[]).map(({ id, name, color }) => ({ id, name, color }));
      const byId = new Map(catalog.map((tag) => [tag.id, tag]));
      const tagsNote = typeof result.tagsError === 'string' ? result.tagsError : undefined;
      const items = ((result.items ?? []) as PersonalTodoWire[]).filter((todo) => {
        if (priority !== undefined && (todo.priority ?? 0) < priority) return false;
        if (tagId !== undefined && !(todo.tagIds ?? []).includes(tagId)) return false;
        const later = todo.status === 'open' && !!todo.deferredUntil && Date.parse(todo.deferredUntil) > Date.now();
        if (view === 'all') return true;
        if (view === 'done') return todo.status === 'done';
        if (view === 'later') return later;
        if (view === 'open') return todo.status === 'open' && !later;
        return todo.status === 'open';
      }).map((todo) => ({
        ...todo,
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
        scope: 'local-current-account',
      });
    },
  });

  registry.register({
    name: 'update_personal_todo',
    category: 'todos',
    description:
      '新建或修改用户本人的个人待办(仅本机、当前登录账号)。新建:不传 id,传 title 和 creationRequestId(1-80 位字母数字、_ 或 -);重试同一次新建必须复用同一个 creationRequestId 才不会重复,内容改了就换新 id。修改:传 id 与最近一次 list_personal_todos 的 expectedRevision,可改 title、notes、deadline(null 清除)、priority(0 无、1 低、2 中、3 高)、tagIds(标签 id 数组,整体替换,最多 16 个,[] 清空;id 取自 list_personal_todos 的 tags,通常只设一个)、subtasks(子任务清单,整体替换,最多 50 步:数组元素 {id?, title, done?};要勾选、改名、删除或调整顺序,先取最近一次 list_personal_todos 的 subtasks,改好后连同 expectedRevision 整个清单一起发送;已有步骤保留原 id,新步骤不带 id;[] 清空),reminder(期限提醒:default=到期时刻,仅日期期限为当天 09:00;off=不提醒;before-15m/before-1h/before-1d=提前 15 分钟/1 小时/1 天),或用 operation 完成(complete)、重开(reopen)、稍后(later,需 until=未来的 ISO 时间)、恢复稍后(restore)、删除(delete)。冲突时先重新列出再基于最新内容重试。',
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
      operation: z.enum(['complete', 'reopen', 'delete', 'later', 'restore']).optional(),
      until: z.string().max(80).optional(),
    },
    handler: (input) => run('update', input),
  });
}
