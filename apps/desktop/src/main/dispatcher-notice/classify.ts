/**
 * 把任务里落库的用户行归类成一轮的输入（纯函数）。依据只有宿主写的来源标记，不看正文语义：
 * - `agent_meta.origin.kind === 'session'` 且带 senderSessionId：别的对话发来的消息；
 *   发送方带伙伴身份（senderBotId），或就是这件任务的派发方，才算派发方（dispatcher）。
 *   伙伴内部协调（botTaskCoordination）与群消息转入不算。
 * - 宿主自动续跑（autoResume）或宿主内部触发行（[UI_ACTION_TRIGGER] 开头、且没有其它来源）：continuation。
 * - 没有来源标记的普通输入：owner（主人亲自说的）。
 * - 其它有来源标记但不算派发方的（定时任务、插件、普通任务之间互发、远程派发方）：other。
 */
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';
import { LOCAL_DEVICE, type DispatcherRef, type TaskRecord, type TurnInput } from './core.js';

export interface PersistedInputRow {
  clientId: string;
  content: string;
  agentMeta: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 用户行正文有两种落库形态：纯文本，或带附件时的 `{"text": ...}`。 */
export function rowText(content: string): string {
  if (!content.startsWith('{')) return content;
  try {
    const parsed = record(JSON.parse(content));
    return typeof parsed?.text === 'string' ? parsed.text : content;
  } catch {
    return content;
  }
}

/** `deviceId::sessionId` → 远程；没有前缀或 local:: 前缀 → 本机。 */
export function parseSender(senderSessionId: string, botId?: string): DispatcherRef {
  const split = senderSessionId.indexOf('::');
  const base = split > 0 && split < senderSessionId.length - 2
    ? { deviceId: senderSessionId.slice(0, split), sessionId: senderSessionId.slice(split + 2) }
    : { deviceId: LOCAL_DEVICE, sessionId: senderSessionId };
  return botId ? { ...base, botId } : base;
}

export function classifyInputRow(row: PersistedInputRow, task: Pick<TaskRecord, 'relation'>): TurnInput {
  let meta: Record<string, unknown> | null = null;
  try { meta = record(JSON.parse(row.agentMeta ?? 'null')); } catch { meta = null; }
  const origin = record(meta?.origin);
  if (meta?.autoResume === true) return { clientId: row.clientId, kind: 'continuation' };
  if (origin?.kind === 'session' && typeof origin.senderSessionId === 'string' && origin.senderSessionId
    && meta?.botTaskCoordination !== true && !origin.groupThread && !origin.groupRequest) {
    const botId = typeof origin.senderBotId === 'string' && origin.senderBotId ? origin.senderBotId : undefined;
    const sender = parseSender(origin.senderSessionId, botId);
    const relation = task.relation?.dispatcher;
    const isDispatcher = relation !== undefined && relation.deviceId === sender.deviceId && relation.sessionId === sender.sessionId;
    // 第一期只投递本机派发方；远程派发方的消息先不建立归属（第二期接远程通道）。
    if ((botId || isDispatcher) && sender.deviceId === LOCAL_DEVICE) {
      return { clientId: row.clientId, kind: 'dispatcher', sender: isDispatcher && relation?.botId && !botId ? { ...sender, botId: relation.botId } : sender };
    }
    return { clientId: row.clientId, kind: 'other' };
  }
  if (!origin && rowText(row.content).trimStart().startsWith(UI_ACTION_TRIGGER_PREFIX)) {
    return { clientId: row.clientId, kind: 'continuation' };
  }
  return { clientId: row.clientId, kind: origin ? 'other' : 'owner' };
}
