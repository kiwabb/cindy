/**
 * 派发方通知 · 宿主适配层。把宿主里已有的信号接到 core 的纯函数上：
 * - 灵动岛的规范活动变化（运行 / 等交互 / 完成 / 出错 / 移除）——主进程里，灵动岛关掉也照常有；
 * - 输入协调器的投影（队列、续跑、投递失败的出错横幅）——判断「真正停下」与「投递前失败」；
 * - 任务里落库的用户行——判断这一轮的输入是谁发的（依据宿主写的来源标记）；
 * - send_to_session 的新建与发送——记派发关系、记「任务已自己回信」。
 * 所有 IO 经注入的 deps，便于单测；每件任务的处理串行，避免并发读改写。
 */
import {
  answerableQuestion,
  LOCAL_DEVICE,
  onAnsweredByDispatcher,
  onDispatchFailed,
  onInteractionResolved,
  onRestart,
  onSelfReport,
  onStopped,
  onStoppedByOwner,
  onTurnStarted,
  onWaiting,
  recordDispatch,
  sameDispatcher,
  type CoreEnv,
  type DispatcherRef,
  type NoticeAction,
  type PendingInteraction,
  type Step,
  type TaskRecord,
} from './core.js';
import { mapReplyToAnswers } from './answerRouting.js';
import { classifyInputRow, type PersistedInputRow } from './classify.js';
import { buildNoticeText, clip, type NoticeLanguage } from './noticeText.js';
import type { DispatcherNoticeStore } from './store.js';

export type ActivityPhase = 'idle' | 'running' | 'needs-interaction' | 'completed' | 'error' | string;

export interface ActivityState {
  phase: ActivityPhase;
  currentTurnActive?: boolean;
  interactionKind?: string;
  startedAtMs: number | null;
}

/** 活动快照变化很频繁（进度、摘要）；只有相位、是否在跑、等待种类或轮次开始时刻变了才值得处理。 */
export function isPhaseEdge(previous: ActivityState | null, current: ActivityState | null): boolean {
  if (!previous || !current) return previous !== current;
  return previous.phase !== current.phase || !!previous.currentTurnActive !== !!current.currentTurnActive
    || previous.interactionKind !== current.interactionKind || previous.startedAtMs !== current.startedAtMs;
}

export interface ActivityTransition {
  sessionId: string;
  previous: ActivityState | null;
  current: ActivityState | null;
}

export interface ProjectionFacts {
  sessionId: string;
  error: string | null;
  /** 投递前失败的那条排队输入（出错横幅 + queue-head 恢复）。 */
  failedHead: PersistedInputRow | null;
}

export type TargetState = 'available' | 'unavailable' | 'unsupported';

export type ReplyRouting =
  | null
  | { answered: true; requestId: string }
  | { answered: false; reason: 'choice-required' | 'empty' | 'not-accepted'; choices?: string[] };

export interface DispatcherNoticeDeps {
  now(): number;
  store: DispatcherNoticeStore;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
  language(): NoticeLanguage;
  /** 连续来回多少次后暂停（0 = 关闭保护）；缺省用 core 的默认值。 */
  loopPauseAfter?(): number;
  /** 自 sinceMs 以来，主人是否在这个派发方对话里亲自说过话。 */
  ownerSpokeSince?(target: DispatcherRef, sinceMs: number): Promise<boolean>;
  /** 用派发方的回复回答任务挂起的提问（与主人在卡片里作答同一条宿主通路）。 */
  answerQuestion?(taskId: string, requestId: string, answers: Record<string, string>): Promise<boolean>;
  /** 这件任务 rowid > afterRowId 的用户行；afterRowId 为 null 时取 createdAt >= sinceMs 的行。按 rowid 升序。 */
  readInputRows(taskId: string, afterRowId: number | null, sinceMs: number | null): Promise<Array<PersistedInputRow & { rowid: number }>>;
  readTaskTitle(taskId: string): Promise<string>;
  /** 任务是否还存在且未归档（归档或删除后清掉记录）。 */
  isTaskLive(taskId: string): Promise<boolean>;
  /** 这一串请求开始之后的最后一段正式回复（不含过程说明）。 */
  readResult(taskId: string, sinceMs: number): Promise<string | null>;
  /** 最近一条出错行的说明。 */
  readLastError(taskId: string, sinceMs: number): Promise<string | null>;
  /** 启动扫描：上一轮开始了但没收尾。 */
  readInterrupted(taskId: string): Promise<boolean>;
  pendingInteractions(taskId: string): PendingInteraction[];
  /** 没有在跑、没有挂起交互、没有排着的续跑、队列里没有可执行的消息。 */
  isSettled(taskId: string): boolean;
  /** 启动扫描用：宿主已经排了续跑（先等队列恢复）。 */
  isResumeQueued(taskId: string): Promise<boolean>;
  isActive(taskId: string): boolean;
  targetState(target: DispatcherRef): Promise<TargetState>;
  queue: {
    isQueued(target: DispatcherRef, clientId: string): boolean;
    deliver(input: { target: DispatcherRef; clientId: string; text: string; taskId: string; taskTitle: string }): Promise<boolean>;
    replace(target: DispatcherRef, clientId: string, text: string): boolean;
    withdraw(target: DispatcherRef, clientId: string): void;
  };
  alertOwner(input: { taskId: string; title: string; body: string; eventId: string }): void;
}

const OWNER_ALERT = {
  zh: {
    loop: (title: string) => `任务「${title}」和派发它的伙伴已经连续来回多次、期间你没有参与，已暂停给伙伴的通知。你在任一边说话后自动恢复。`,
    unavailable: (title: string) => `任务「${title}」有状态变化，但派发它的对话已归档、删除或暂停，请直接查看任务。`,
  },
  en: {
    loop: (title: string) => `Task "${title}" and the teammate that dispatched it went back and forth many times without you, so notices to the teammate are paused. They resume when you speak on either side.`,
    unavailable: (title: string) => `Task "${title}" changed state, but the conversation that dispatched it is archived, deleted or paused. Check the task.`,
  },
} as const;

export function createDispatcherNoticeService(deps: DispatcherNoticeDeps) {
  const chains = new Map<string, Promise<void>>();
  /** 还挂着请求的任务（内存索引，给高频的投影回调做快速过滤）。 */
  const open = new Set<string>();
  /** 已处理过的投递失败（同一条输入只通知一次；进程内即可，重启后横幅也会重来一次由去重 id 兜住）。 */
  const failedInputs = new Set<string>();

  const serial = (taskId: string, run: () => Promise<void>): Promise<void> => {
    const previous = chains.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run).catch((error: unknown) => {
      deps.log.warn('dispatcher notice step failed', { taskId, error: error instanceof Error ? error.message : String(error) });
    });
    chains.set(taskId, next);
    void next.finally(() => { if (chains.get(taskId) === next) chains.delete(taskId); });
    return next;
  };

  const queued = (target: DispatcherRef, clientId: string) => target.deviceId === LOCAL_DEVICE && deps.queue.isQueued(target, clientId);

  /** 每一步的环境：排队探测、暂停阈值，以及「上次通知以来主人是否在派发方对话里说过话」（异步预读）。 */
  async function envFor(record: TaskRecord): Promise<CoreEnv> {
    const spoke = new Set<string>();
    if (deps.ownerSpokeSince && record.loop && (record.loop.exchanges > 0 || record.loop.paused)) {
      for (const owner of record.chain?.owners ?? (record.relation ? [record.relation.dispatcher] : [])) {
        const last = Math.max(0, ...record.sent.filter(entry => sameDispatcher(entry.target, owner)).map(entry => entry.at));
        if (await deps.ownerSpokeSince(owner, record.loop.since ?? last)) spoke.add(`${owner.deviceId}:${owner.sessionId}`);
      }
    }
    return {
      queued,
      ...(deps.loopPauseAfter ? { pauseAfter: deps.loopPauseAfter() } : {}),
      ownerSpoke: target => spoke.has(`${target.deviceId}:${target.sessionId}`),
    };
  }

  async function apply(taskId: string, actions: NoticeAction[]): Promise<void> {
    if (!actions.length) return;
    const title = await deps.readTaskTitle(taskId);
    const lang = deps.language();
    for (const action of actions) {
      if (action.type === 'withdraw') {
        if (action.target.deviceId === LOCAL_DEVICE) deps.queue.withdraw(action.target, action.clientId);
        continue;
      }
      if (action.type === 'owner-alert') {
        deps.alertOwner({ taskId, title, body: OWNER_ALERT[lang].loop(clip(title, 80)), eventId: `dispatcher-notice-loop:${taskId}:${deps.now()}` });
        continue;
      }
      const { notice } = action;
      const text = buildNoticeText(notice, { title, lang,
        replyAnswers: !!deps.answerQuestion && notice.target.deviceId === LOCAL_DEVICE });
      const state = await deps.targetState(notice.target);
      if (state !== 'available') {
        // 派发方对话已归档 / 删除 / 伙伴暂停，或第一期还不支持的远程派发方：改给主人发系统提醒。
        deps.alertOwner({ taskId, title, body: OWNER_ALERT[lang].unavailable(clip(title, 80)), eventId: notice.id });
        continue;
      }
      if (action.replaceClientId && deps.queue.replace(notice.target, action.replaceClientId, text)) continue;
      const accepted = await deps.queue.deliver({ target: notice.target, clientId: notice.id, text, taskId, taskTitle: title });
      if (!accepted) {
        deps.log.warn('dispatcher notice not accepted', { taskId, kind: notice.kind });
        deps.alertOwner({ taskId, title, body: OWNER_ALERT[lang].unavailable(clip(title, 80)), eventId: notice.id });
      }
    }
  }

  async function update(taskId: string, change: (record: TaskRecord, env: CoreEnv) => Step | TaskRecord): Promise<void> {
    let actions: NoticeAction[] = [];
    const env = await envFor(await deps.store.read(taskId));
    const written = await deps.store.update(taskId, record => {
      const result = change(record, env);
      if ('actions' in result) {
        actions = result.actions;
        return result.record;
      }
      return result;
    });
    if (written?.chain) open.add(taskId);
    else open.delete(taskId);
    await apply(taskId, actions);
  }

  /** 把这件任务新落库的用户行归入当前这一轮。没有记录且没有派发方消息时不建记录。 */
  async function syncInputs(taskId: string, current: ActivityState): Promise<void> {
    const before = await deps.store.read(taskId);
    // 派发方新建的任务从第一条消息读起；别的任务第一次被看到时只读这一轮开始以来的行，不翻旧历史。
    const afterRowId = before.inputCursor ?? (before.relation ? 0 : null);
    const rows = await deps.readInputRows(taskId, afterRowId,
      afterRowId === null ? (current.startedAtMs ?? deps.now()) - 2_000 : null);
    if (!rows.length) return;
    const inputs = rows.map(row => classifyInputRow(row, before));
    const hasDispatcher = inputs.some(input => input.kind === 'dispatcher');
    if (!hasDispatcher && !before.relation && !before.chain) return;
    const cursor = rows[rows.length - 1]!.rowid;
    await update(taskId, record => ({ ...onTurnStarted(record, inputs, deps.now()), inputCursor: cursor }));
  }

  async function checkWaiting(taskId: string): Promise<void> {
    const pending = deps.pendingInteractions(taskId);
    const ids = new Set(pending.map(item => item.id));
    const record = await deps.store.read(taskId);
    for (const id of record.chain?.waitingNotified ?? []) {
      if (!ids.has(id)) await update(taskId, (current, env) => onInteractionResolved(current, id, deps.now(), env));
    }
    for (const interaction of pending) {
      await update(taskId, (current, env) => onWaiting(current, interaction, deps.now(), env));
    }
  }

  async function checkStopped(taskId: string, phase: 'completed' | 'error'): Promise<void> {
    const record = await deps.store.read(taskId);
    const chain = record.chain;
    if (!chain) return;
    const settled = deps.isSettled(taskId);
    const result = settled && phase === 'completed' ? await deps.readResult(taskId, chain.startedAt) : null;
    const error = phase === 'error' ? await deps.readLastError(taskId, chain.startedAt) : null;
    await update(taskId, (current, env) => onStopped(current, { phase, settled,
      ...(result ? { result } : {}), ...(error ? { error } : {}) }, deps.now(), env));
  }

  return {
    /** 灵动岛规范活动变化。 */
    onActivity(transition: ActivityTransition): Promise<void> {
      const { sessionId, previous, current } = transition;
      if (!isPhaseEdge(previous, current)) return Promise.resolve();
      return serial(sessionId, async () => {
        if (!current) {
          // 运行中或等待中被移除：主人停止（或任务被关闭）。静默结清。
          if (previous && (previous.phase === 'running' || previous.phase === 'needs-interaction')) {
            const record = await deps.store.read(sessionId);
            if (record.chain) await update(sessionId, onStoppedByOwner);
          }
          return;
        }
        if (current.phase === 'needs-interaction') {
          await syncInputs(sessionId, current);
          await checkWaiting(sessionId);
          return;
        }
        if ((current.phase === 'completed' || current.phase === 'error') && !current.currentTurnActive) {
          await syncInputs(sessionId, current);
          await checkWaiting(sessionId);
          await checkStopped(sessionId, current.phase);
          return;
        }
        if (previous?.phase === 'needs-interaction' && current.phase === 'running') await checkWaiting(sessionId);
      });
    },

    /** 输入协调器投影变化：补判「真正停下」，以及派发方消息投递前失败。 */
    onProjection(facts: ProjectionFacts): Promise<void> {
      const { sessionId } = facts;
      return serial(sessionId, async () => {
        if (facts.error && facts.failedHead && !failedInputs.has(`${sessionId}:${facts.failedHead.clientId}`)) {
          failedInputs.add(`${sessionId}:${facts.failedHead.clientId}`);
          const record = await deps.store.read(sessionId);
          const input = classifyInputRow(facts.failedHead, record);
          if (input.kind === 'dispatcher' || record.chain) {
            await update(sessionId, (current, env) => onDispatchFailed(current, input, facts.error!, deps.now(), env));
            return;
          }
        }
        const record = await deps.store.read(sessionId);
        if (record.chain?.lastTerminal && deps.isSettled(sessionId)) await checkStopped(sessionId, record.chain.lastTerminal);
      });
    },

    /** send_to_session 在本机新建任务成功。 */
    noteTaskCreated(taskId: string, dispatcher: DispatcherRef, notify = true): Promise<void> {
      return serial(taskId, () => update(taskId, record => recordDispatch(record, dispatcher, notify, deps.now())));
    },

    /** 某个任务用 send_to_session 给另一个对话发了消息：如果它正替这个对话干活，就算已自己回信。 */
    noteTaskMessage(senderTaskId: string, target: DispatcherRef): Promise<void> {
      return serial(senderTaskId, async () => {
        const record = await deps.store.read(senderTaskId);
        if (!record.chain?.owners.some(owner => sameDispatcher(owner, target))) return;
        await update(senderTaskId, current => onSelfReport(current, target));
      });
    },

    /** Cindy 启动后补判还挂着请求的任务；归档或删除的任务清掉记录。 */
    async restartScan(): Promise<void> {
      const records = await deps.store.list();
      for (const record of records) if (record.chain) open.add(record.taskId);
      await Promise.all(records.map(record => serial(record.taskId, async () => {
        if (!(await deps.isTaskLive(record.taskId))) {
          await deps.store.remove(record.taskId);
          return;
        }
        if (!record.chain) return;
        const facts = {
          interrupted: await deps.readInterrupted(record.taskId),
          resumeQueued: await deps.isResumeQueued(record.taskId),
          active: deps.isActive(record.taskId),
        };
        await update(record.taskId, (current, env) => onRestart(current, facts, deps.now(), env));
      })));
    },

    /**
     * 派发方用 send_to_session 给任务发消息之前调用：任务正停在由它这串请求引出的提问上，就把这条消息
     * 当作回答交进去。返回 null 表示不适用（照常投递）；answered=false 表示适用但没能作答（照常投递并告诉派发方原因）。
     */
    async routeReply(taskId: string, sender: DispatcherRef, message: string): Promise<ReplyRouting> {
      if (!deps.answerQuestion || sender.deviceId !== LOCAL_DEVICE) return null;
      let outcome: ReplyRouting = null;
      await serial(taskId, async () => {
        const record = await deps.store.read(taskId);
        const pendingRaw = deps.pendingInteractions(taskId);
        const question = answerableQuestion(record, sender, pendingRaw);
        if (!question) return;
        const mapped = mapReplyToAnswers((question.questions ?? []).map(q => ({
          question: q.question, ...(q.id ? { id: q.id } : {}),
          options: q.options.map(label => ({ label })),
          ...(q.multiSelect ? { multiSelect: true } : {}),
          ...(q.choices ? { answerConstraints: { required: true, choices: q.choices } } : {}),
        })), message);
        if (!mapped.ok) {
          outcome = { answered: false, reason: mapped.reason, ...(mapped.choices ? { choices: mapped.choices } : {}) };
          return;
        }
        if (!(await deps.answerQuestion!(taskId, question.id, mapped.answers))) {
          outcome = { answered: false, reason: 'not-accepted' };
          return;
        }
        await update(taskId, current => onAnsweredByDispatcher(current, question.id));
        outcome = { answered: true, requestId: question.id };
      });
      return outcome;
    },

    hasOpenRequest(taskId: string): boolean {
      return open.has(taskId);
    },

    /** 任务归档或删除。 */
    forgetTask(taskId: string): Promise<void> {
      open.delete(taskId);
      return serial(taskId, () => deps.store.remove(taskId));
    },

    /** 测试与关闭用：等所有排队步骤结束。 */
    async idle(): Promise<void> {
      while (chains.size) await Promise.all([...chains.values()]);
    },
  };
}

export type DispatcherNoticeService = ReturnType<typeof createDispatcherNoticeService>;
