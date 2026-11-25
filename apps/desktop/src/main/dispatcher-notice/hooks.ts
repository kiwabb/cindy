/**
 * 派发方通知 · 轻量挂钩点。register.ts 与 mcp-providers.ts 只依赖这里（不引入 Electron、通知、设备互联），
 * Desktop 装配（desktop.ts）在启动时注册真正的实现；未注册时所有调用都是空操作。
 */
import type { AgentInputProjection } from '../../shared/agentInputQueue.js';
import type { DispatcherRef } from './core.js';

/** register.ts 在 registerMakerIpc 内安装：只暴露通知需要的最小宿主能力。 */
export interface DispatcherNoticeHostBridge {
  send(input: { targetSessionId: string; clientId: string; text: string; taskId: string; taskTitle: string }): Promise<boolean>;
  isQueued(sessionId: string, clientId: string): boolean;
  withdraw(sessionId: string, clientId: string): void;
  /** 没有在跑、没有挂起交互、没有排着的续跑、队列里没有可执行的消息。 */
  isSettled(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
  isResumeQueued(sessionId: string): Promise<boolean>;
  pendingInteractions(sessionId: string): unknown[];
  /** 用一组回答结清任务挂起的提问（与主人在卡片里作答同一条宿主通路）。 */
  answerQuestion(sessionId: string, requestId: string, answers: Record<string, string>): Promise<boolean>;
}

/** 派发方的回复被当作提问回答的结果（null = 不适用，照常投递）。 */
export type DispatcherReplyRouting =
  | null
  | { answered: true; requestId: string }
  | { answered: false; reason: 'choice-required' | 'empty' | 'not-accepted'; choices?: string[] };

export interface DispatcherNoticeHooks {
  onProjection(projection: Pick<AgentInputProjection, 'sessionId' | 'error' | 'recovery' | 'pendingQueue'>): void;
  taskCreated(taskId: string, dispatcherSessionId: string): void;
  taskMessage(senderTaskId: string, target: DispatcherRef): void;
  routeReply(taskId: string, senderSessionId: string, message: string): Promise<DispatcherReplyRouting>;
}

let bridge: DispatcherNoticeHostBridge | null = null;
let hooks: DispatcherNoticeHooks | null = null;

export function installDispatcherNoticeBridge(next: DispatcherNoticeHostBridge): void {
  bridge = next;
}

export function getDispatcherNoticeBridge(): DispatcherNoticeHostBridge | null {
  return bridge;
}

export function registerDispatcherNoticeHooks(next: DispatcherNoticeHooks | null): void {
  hooks = next;
}

export function dispatcherNoticeOnProjection(projection: Parameters<DispatcherNoticeHooks['onProjection']>[0]): void {
  hooks?.onProjection(projection);
}

export function dispatcherNoticeTaskCreated(taskId: string, dispatcherSessionId: string): void {
  hooks?.taskCreated(taskId, dispatcherSessionId);
}

export function dispatcherNoticeTaskMessage(senderTaskId: string, target: DispatcherRef): void {
  hooks?.taskMessage(senderTaskId, target);
}

/** send_to_session 发给本机已有任务之前：任务正等着这位派发方请求里的提问时，把消息当作回答交进去。 */
export async function dispatcherNoticeRouteReply(taskId: string, senderSessionId: string, message: string): Promise<DispatcherReplyRouting> {
  try {
    return (await hooks?.routeReply(taskId, senderSessionId, message)) ?? null;
  } catch {
    return null;
  }
}
