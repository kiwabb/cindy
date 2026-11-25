/**
 * 派发方通知 · Desktop 装配。把 service 的依赖接到真实宿主：
 * - 存储：账号隔离的用户数据目录（ownerScopedUserDataPath），跨进程锁；
 * - 读库：任务的用户行、标题、正式回复、出错行、是否被打断；
 * - 宿主桥（register.ts 在 registerMakerIpc 里安装）：投递、撤回、队列与续跑状态、挂起交互；
 * - 主人提醒：桌面通知 + 手机推送（与其它任务提醒同一入口）。
 * 账号切换时丢弃旧实例；新账号的数据库就绪后做一次启动扫描。
 */
import type { BrowserWindow } from 'electron';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { getMobileNotifyGeneration, sendMobileSessionNotify } from '../device-link/index.js';
import { runOutsideDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { runTaskActionRequest } from '../maker-ipc/taskActionAuthorization.js';
import { getResolvedMainLocale } from '../i18n.desktop.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { showDesktopSessionEvent } from '../notificationService.js';
import { LOCAL_DEVICE, type DispatcherRef } from './core.js';
import { record, text, toPendingInteraction } from './pendingInteraction.js';
import type { AgentInputProjection } from '../../shared/agentInputQueue.js';
import type { PersistedInputRow } from './classify.js';
import { createDispatcherNoticeService, type ActivityTransition, type DispatcherNoticeService, type ProjectionFacts } from './service.js';
import { createDispatcherNoticeStore } from './store.js';
import { getDispatcherNoticeBridge, registerDispatcherNoticeHooks, type DispatcherReplyRouting } from './hooks.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOOP_PAUSE_AFTER } from './core.js';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

const log = createLogger('dispatcher-notice');
const SCAN_RETRY_MS = 5_000;
const SCAN_MAX_ATTEMPTS = 24;

let getMainWindow: () => BrowserWindow | null = () => null;
let active: { scope: string; service: DispatcherNoticeService } | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;

export function configureDispatcherNotice(options: { getMainWindow: () => BrowserWindow | null }): void {
  getMainWindow = options.getMainWindow;
}

function db() {
  const client = tryGetDbClient();
  if (!client) throw new Error('database not ready');
  return client;
}

/**
 * 可配置项：账号数据目录下 dispatcher-notice/settings.json 的 `loopPauseAfter`
 * （主人没参与的连续来回多少次后暂停通知；0 = 关闭）。没有文件或读不了时用默认值。
 */
function readLoopPauseAfter(dir: string): number {
  try {
    const value = (JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { loopPauseAfter?: unknown }).loopPauseAfter;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DEFAULT_LOOP_PAUSE_AFTER;
  } catch {
    return DEFAULT_LOOP_PAUSE_AFTER;
  }
}

function createService(scope: string): DispatcherNoticeService {
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) throw new Error('OWNER_SCOPE_CHANGED');
  };
  const dir = ownerScopedUserDataPath('dispatcher-notice');
  const store = createDispatcherNoticeStore({
    dir,
    lock: (file, run) => withCrossProcessLock(file, { label: 'dispatcher-notice' }, async (status) => {
      if (!status.held) throw new Error('dispatcher notice store busy');
      assertCurrent();
      return run();
    }),
    onCorrupt: (taskId, error) => log.warn('dispatcher notice record unreadable', {
      hasTask: taskId !== null, error: error instanceof Error ? error.message : String(error),
    }),
  });
  const requireBridge = () => {
    const bridge = getDispatcherNoticeBridge();
    if (!bridge) throw new Error('dispatcher notice host bridge not installed');
    return bridge;
  };
  return createDispatcherNoticeService({
    now: () => Date.now(),
    store,
    log,
    language: () => (getResolvedMainLocale().startsWith('zh') ? 'zh' : 'en'),
    async readInputRows(taskId, afterRowId, sinceMs) {
      const where = afterRowId !== null ? 'm.rowid > ?' : 'm.created_at >= ?';
      return db().query<PersistedInputRow & { rowid: number }>(`
        SELECT m.rowid AS rowid, m.client_id AS clientId, m.content AS content, m.agent_meta AS agentMeta
        FROM messages m WHERE m.session_id = ? AND m.role = 'user' AND m.rewind_at IS NULL AND ${where}
        ORDER BY m.rowid LIMIT 200`, [taskId, afterRowId ?? sinceMs ?? 0]);
    },
    async readTaskTitle(taskId) {
      const row = await db().queryOne<{ title: string | null }>('SELECT title FROM sessions WHERE id = ?', [taskId]);
      return row?.title?.trim() || taskId;
    },
    async isTaskLive(taskId) {
      const row = await db().queryOne<{ status: string }>('SELECT status FROM sessions WHERE id = ?', [taskId]);
      return row?.status === 'active';
    },
    async readResult(taskId, sinceMs) {
      const rows = await db().query<{ content: string; agentMeta: string | null }>(`
        SELECT content, agent_meta AS agentMeta FROM messages
        WHERE session_id = ? AND role = 'assistant' AND rewind_at IS NULL AND created_at >= ?
        ORDER BY rowid DESC LIMIT 20`, [taskId, sinceMs]);
      let fallback: string | null = null;
      for (const row of rows) {
        let meta: Record<string, unknown> | null = null;
        try { meta = record(JSON.parse(row.agentMeta ?? 'null')); } catch { meta = null; }
        if (meta?.parentUuid || meta?.botPrivateReply) continue;
        const body = text(row.content);
        if (!body) continue;
        if (meta?.assistantPhase !== 'commentary') return body;
        fallback ??= body;
      }
      return fallback;
    },
    async readLastError(taskId, sinceMs) {
      const row = await db().queryOne<{ content: string }>(`
        SELECT content FROM messages WHERE session_id = ? AND role = 'error' AND rewind_at IS NULL AND created_at >= ?
        ORDER BY rowid DESC LIMIT 1`, [taskId, sinceMs]);
      if (!row) return null;
      try { return text(record(JSON.parse(row.content))?.message) ?? text(row.content); } catch { return text(row.content); }
    },
    async readInterrupted(taskId) {
      const row = await db().queryOne<{ started: number | null; ended: number | null }>(
        'SELECT active_turn_started_at AS started, last_turn_ended_at AS ended FROM sessions WHERE id = ?', [taskId]);
      return !!row?.started && row.started > (row.ended ?? 0);
    },
    pendingInteractions: (taskId) => (getDispatcherNoticeBridge()?.pendingInteractions(taskId) ?? [])
      .flatMap(item => { const parsed = toPendingInteraction(item); return parsed ? [parsed] : []; }),
    loopPauseAfter: () => readLoopPauseAfter(dir),
    async ownerSpokeSince(target, sinceMs) {
      if (target.deviceId !== LOCAL_DEVICE) return false;
      // 主人亲自说的话：没有来源标记、不是宿主续跑、不是宿主内部触发行。
      const rows = await db().query<{ content: string; agentMeta: string | null }>(`
        SELECT content, agent_meta AS agentMeta FROM messages
        WHERE session_id = ? AND role = 'user' AND rewind_at IS NULL AND created_at > ?
        ORDER BY rowid DESC LIMIT 50`, [target.sessionId, sinceMs]);
      return rows.some(row => {
        let meta: Record<string, unknown> | null = null;
        try { meta = record(JSON.parse(row.agentMeta ?? 'null')); } catch { meta = null; }
        if (meta?.origin || meta?.autoResume === true) return false;
        return !row.content.includes(UI_ACTION_TRIGGER_PREFIX);
      });
    },
    answerQuestion: (taskId, requestId, answers) => requireBridge().answerQuestion(taskId, requestId, answers),
    isSettled: (taskId) => requireBridge().isSettled(taskId),
    isActive: (taskId) => requireBridge().isActive(taskId),
    isResumeQueued: (taskId) => requireBridge().isResumeQueued(taskId),
    async targetState(target: DispatcherRef) {
      if (target.deviceId !== LOCAL_DEVICE) return 'unsupported';
      const session = await db().queryOne<{ status: string }>('SELECT status FROM sessions WHERE id = ?', [target.sessionId]);
      if (session?.status !== 'active') return 'unavailable';
      const bot = await db().queryOne<{ status: string }>(`
        SELECT p.status AS status FROM bot_session_links l JOIN bot_profiles p ON p.id = l.bot_id
        WHERE l.session_id = ? AND l.archived_at IS NULL LIMIT 1`, [target.sessionId]);
      return bot && bot.status !== 'active' ? 'unavailable' : 'available';
    },
    queue: {
      isQueued: (target, clientId) => getDispatcherNoticeBridge()?.isQueued(target.sessionId, clientId) ?? false,
      deliver: ({ target, clientId, text: body, taskId, taskTitle }) => {
        assertCurrent();
        return requireBridge().send({ targetSessionId: target.sessionId, clientId, text: body, taskId, taskTitle });
      },
      // 换内容＝撤回旧的再按新 id 排一条；队列本来就是先进先出，不影响「排在主人消息之后」。
      replace: (target, clientId) => {
        const bridge = getDispatcherNoticeBridge();
        if (bridge?.isQueued(target.sessionId, clientId)) bridge.withdraw(target.sessionId, clientId);
        return false;
      },
      withdraw: (target, clientId) => getDispatcherNoticeBridge()?.withdraw(target.sessionId, clientId),
    },
    alertOwner({ taskId, title, body, eventId }) {
      try {
        showDesktopSessionEvent(getMainWindow, { sessionId: taskId, title, kind: 'error', body });
        sendMobileSessionNotify({ sessionId: taskId, title, kind: 'error', detail: body,
          eventId: `dispatcher-notice:${eventId}`, generation: getMobileNotifyGeneration() });
      } catch (error) {
        log.warn('dispatcher notice owner alert failed', { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

function scheduleRestartScan(scope: string, service: DispatcherNoticeService, attempt = 0): void {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    if (active?.scope !== scope || active.service !== service) return;
    if (!tryGetDbClient() || !getDispatcherNoticeBridge()) {
      if (attempt < SCAN_MAX_ATTEMPTS) scheduleRestartScan(scope, service, attempt + 1);
      return;
    }
    service.restartScan().catch(error => log.warn('dispatcher notice restart scan failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, SCAN_RETRY_MS);
  scanTimer.unref?.();
}

/** 当前账号的实例；账号切换后重建，并在数据库就绪后补一次启动扫描。 */
function current(): DispatcherNoticeService | null {
  if (isAppSessionBoundaryPending()) return null;
  const scope = activeOwnerScopeKey();
  if (active?.scope === scope) return active.service;
  const service = createService(scope);
  active = { scope, service };
  scheduleRestartScan(scope, service);
  return service;
}

function guard(label: string, run: (service: DispatcherNoticeService) => Promise<void>): void {
  try {
    const service = current();
    // 通知由宿主事件触发，不继承触发它的那次工具调用或远程调用的授权上下文。
    if (service) void runOutsideDeviceLinkInvokeContext(() => runTaskActionRequest(() => run(service))).catch(error => log.warn(`dispatcher notice ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    }));
  } catch (error) {
    log.warn(`dispatcher notice ${label} failed`, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function dispatcherNoticeOnActivity(transition: ActivityTransition): void {
  guard('activity', service => service.onActivity(transition));
}

/** 输入协调器投影（register.ts 的 emitProjection 里调用，高频：没有挂着的请求且没有投递失败时直接返回）。 */
function onProjection(projection: Pick<AgentInputProjection, 'sessionId' | 'error' | 'recovery' | 'pendingQueue'>): void {
  const head = projection.recovery?.kind === 'queue-head'
    ? projection.pendingQueue.find(item => item.clientId === (projection.recovery as { clientId: string }).clientId) : undefined;
  const failedHead = projection.error && head ? {
    clientId: head.clientId,
    content: typeof head.text === 'string' ? head.text : '',
    agentMeta: JSON.stringify({ origin: head.origin, autoResume: head.autoResume === true, botTaskCoordination: !!head.botTaskCoordination }),
  } : null;
  if (!failedHead && !active?.service.hasOpenRequest(projection.sessionId)) return;
  const facts: ProjectionFacts = { sessionId: projection.sessionId, error: projection.error, failedHead };
  guard('projection', service => service.onProjection(facts));
}

function taskCreated(taskId: string, dispatcherSessionId: string): void {
  guard('create', service => service.noteTaskCreated(taskId, { deviceId: LOCAL_DEVICE, sessionId: dispatcherSessionId }));
}

function taskMessage(senderTaskId: string, target: DispatcherRef): void {
  guard('message', service => service.noteTaskMessage(senderTaskId, target));
}

/** 启动时调用一次：确保当前账号有实例并安排启动扫描。 */
async function routeReply(taskId: string, senderSessionId: string, message: string): Promise<DispatcherReplyRouting> {
  const service = current();
  if (!service) return null;
  return runOutsideDeviceLinkInvokeContext(() => runTaskActionRequest(() =>
    service.routeReply(taskId, { deviceId: LOCAL_DEVICE, sessionId: senderSessionId }, message)));
}

export function initDispatcherNotice(): void {
  registerDispatcherNoticeHooks({ onProjection, taskCreated, taskMessage, routeReply });
  guard('init', async () => undefined);
}
