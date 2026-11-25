/**
 * 派发方通知 · 轻量挂钩点。register.ts 与 mcp-providers.ts 只依赖这里（不引入 Electron、通知、设备互联），
 * Desktop 装配（desktop.ts）在启动时注册真正的实现；未注册时所有调用都是空操作。
 */
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
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
}

export interface DispatcherNoticeHooks {
  onProjection(projection: Pick<AgentInputProjection, 'sessionId' | 'error' | 'recovery' | 'pendingQueue'>): void;
  taskCreated(taskId: string, dispatcherSessionId: string): void;
  taskMessage(senderTaskId: string, target: DispatcherRef): void;
  interceptQuestion(sessionId: string, request: InteractionRequest): Promise<InteractionDecision | null>;
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

/**
 * 任务提问时（宿主交互入口，三种引擎共用）：伙伴发起的请求由宿主转交伙伴并返回给任务的结果；
 * 返回 null 表示照旧弹卡片给主人。任何异常都按 null 处理，绝不吞掉提问。
 */
export async function dispatcherNoticeInterceptQuestion(sessionId: string, request: InteractionRequest): Promise<InteractionDecision | null> {
  if (request.kind !== 'ask_user_question' || !hooks) return null;
  try {
    return await hooks.interceptQuestion(sessionId, request);
  } catch {
    return null;
  }
}
