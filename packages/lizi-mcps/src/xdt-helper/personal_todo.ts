import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
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
  [key: string]: unknown;
}

export interface PersonalTodoCallbacks {
  (
    operation: 'list' | 'update',
    input?: Record<string, unknown>,
  ): Promise<ControlResult<Record<string, unknown>, string>>;
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
      '列出用户本人的个人待办(仅本机、当前登录账号)。返回 id、revision、标题、备注、期限、状态、稍后到期时间;修改前用它取最新 revision。view:open=未完成且未稍后、later=稍后中、done=已完成、all=全部;默认未完成含稍后。',
    inputShape: {
      view: z.enum(['open', 'later', 'done', 'all']).optional(),
    },
    handler: async ({ view }) => {
      const result = await callback('list');
      if (!result.ok) return errorPayload(result.errorCode, HINTS[result.errorCode] ?? result.message);
      const items = ((result.items ?? []) as PersonalTodoWire[]).filter((todo) => {
        const later = todo.status === 'open' && !!todo.deferredUntil && Date.parse(todo.deferredUntil) > Date.now();
        if (view === 'all') return true;
        if (view === 'done') return todo.status === 'done';
        if (view === 'later') return later;
        if (view === 'open') return todo.status === 'open' && !later;
        return todo.status === 'open';
      });
      return okPayload({ items, total: items.length, scope: 'local-current-account' });
    },
  });

  registry.register({
    name: 'update_personal_todo',
    category: 'todos',
    description:
      '新建或修改用户本人的个人待办(仅本机、当前登录账号)。新建:不传 id,传 title 和 creationRequestId(1-80 位字母数字、_ 或 -);重试同一次新建必须复用同一个 creationRequestId 才不会重复,内容改了就换新 id。修改:传 id 与最近一次 list_personal_todos 的 expectedRevision,可改 title、notes、deadline(null 清除),或用 operation 完成(complete)、重开(reopen)、稍后(later,需 until=未来的 ISO 时间)、恢复稍后(restore)、删除(delete)。冲突时先重新列出再基于最新内容重试。',
    inputShape: {
      id: z.string().max(128).optional(),
      creationRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      title: z.string().min(1).max(300).optional(),
      notes: z.string().max(4000).optional(),
      deadline: deadline.nullable().optional(),
      operation: z.enum(['complete', 'reopen', 'delete', 'later', 'restore']).optional(),
      until: z.string().max(80).optional(),
    },
    handler: (input) => run('update', input),
  });
}
