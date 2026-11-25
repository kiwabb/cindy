/**
 * 派发方通知 · 纯逻辑（不碰 IO / 模型 / Electron）。
 *
 * 伙伴（或派发方任务）发来的请求，由宿主在任务真正停下时通知派发方；任务里的 Agent 不参与。
 * 规则（docs/product-rules/dispatcher-notice.md）：
 * - 一轮处理过的输入里只要有派发方的消息，这一轮就归派发方；主人插话不改变归属。
 * - 宿主自己的续跑（出错重试、重启后接着做、用量恢复）沿用上一轮的归属。
 * - 只有主人（或其它非派发方来源）输入的轮次不建立归属。
 * - 任务真正停下（没有在跑、没有排着的续跑、队列里没有可执行的消息）才发「完成 / 出错」。
 * - 等待（提问、选项、计划、权限）立即发，同一次等待只发一次；主人先处理掉就撤回或补一句。
 * - 主人手动停止：静默结清。
 * - 任务这串请求期间已自己发回派发方：不再发「完成」，出错与等待照发。
 * - 不按天限量：正常通知一条都不吞。只有「派发方与任务连续来回、期间主人在两边都没说话」达到可配置次数
 *   （默认很宽，0 = 关闭）时暂停这件任务的通知，给主人发提醒、给派发方发最后一条「已暂停」；主人在任一边说话即恢复。
 *
 * 所有函数都是 (record, input) -> { record, actions } 的纯函数；宿主适配层负责读状态、投递与持久化。
 */

/** 派发方：哪台电脑上的哪个对话。第一期只投递 deviceId === 'local'，其它返回暂不支持。 */
export interface DispatcherRef {
  deviceId: string;
  sessionId: string;
  botId?: string;
}

export const LOCAL_DEVICE = 'local';

export function sameDispatcher(a: DispatcherRef, b: DispatcherRef): boolean {
  return a.deviceId === b.deviceId && a.sessionId === b.sessionId;
}

/**
 * 一轮里的一条输入，由适配层归类：
 * - dispatcher：有资格收通知的派发方发来的（伙伴对话，或这件任务的派发方）；
 * - continuation：宿主自己的续跑 / 重试 / 重启后接着做；
 * - owner：主人输入，以及其它不建立归属的来源（定时任务、插件、普通任务之间互发等）。
 */
export type TurnInputKind = 'dispatcher' | 'continuation' | 'owner';

export interface TurnInput {
  clientId: string;
  kind: TurnInputKind;
  sender?: DispatcherRef;
}

export type NoticeKind = 'done' | 'error' | 'interrupted' | 'dispatch-failed' | 'waiting' | 'resolved' | 'paused';
type NoticeBucket = 'result' | 'waiting';

export function noticeBucket(kind: NoticeKind): NoticeBucket {
  return kind === 'waiting' || kind === 'resolved' ? 'waiting' : 'result';
}

export type InteractionKind = 'question' | 'plan' | 'permission' | 'other';

export interface PendingQuestion {
  question: string;
  options: string[];
  /** 题目的稳定 id（回答按它作键；旧题没有，用题干）。 */
  id?: string;
  multiSelect?: boolean;
  /** 只能从这些选项里选（不接受手打文字）。 */
  choices?: string[];
}

export interface PendingInteraction {
  id: string;
  kind: InteractionKind;
  /** 提问类：问题原文与选项。 */
  questions?: PendingQuestion[];
  /** 权限类：工具或操作名（不含参数）。 */
  title?: string;
}

/** 已发出的通知（用于合并、撤回与上限）。 */
export interface SentNotice {
  id: string;
  kind: NoticeKind;
  at: number;
  target: DispatcherRef;
  /** 投递到派发方队列时用的稳定 id，也用于替换或撤回。 */
  clientId: string;
  interactionId?: string;
}

export interface Chain {
  owners: DispatcherRef[];
  startedAt: number;
  ownerInterjected: boolean;
  /** 本串请求期间，任务自己已发回的派发方。 */
  selfReportedTo: DispatcherRef[];
  /** 已经通知过的等待（交互 id）。 */
  waitingNotified: string[];
  /** 最近一次回合终态；用于重启后补判。 */
  lastTerminal: 'completed' | 'error' | null;
  lastError?: string;
}

export interface TaskRecord {
  taskId: string;
  /** send_to_session 新建任务时记下的派发关系；常驻到任务归档或删除。 */
  relation: { dispatcher: DispatcherRef; createdAt: number; notify: boolean } | null;
  chain: Chain | null;
  /** 最近 24 小时发过的通知。 */
  sent: SentNotice[];
  /** 主人没参与的连续来回次数与暂停状态。 */
  loop?: { exchanges: number; paused: boolean; since?: number };
  /** 已归类过的最后一条用户行（数据库 rowid）；之后的行属于新的输入。 */
  inputCursor?: number;
}

export function emptyRecord(taskId: string): TaskRecord {
  return { taskId, relation: null, chain: null, sent: [] };
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  taskId: string;
  target: DispatcherRef;
  clientId: string;
  ownerInterjected: boolean;
  error?: string;
  result?: string;
  interaction?: PendingInteraction;
}

export type NoticeAction =
  /** 投递一条通知；replaceClientId 指向同一目标还没被处理的旧通知，适配层能替换就替换。 */
  | { type: 'deliver'; notice: Notice; replaceClientId?: string }
  /** 撤回还在派发方队列里没被处理的通知。 */
  | { type: 'withdraw'; target: DispatcherRef; clientId: string }
  /** 给主人发系统提醒（连续来回达到设定次数，已暂停这件任务的通知）。 */
  | { type: 'owner-alert'; reason: 'loop-paused'; taskId: string };

export interface Step {
  record: TaskRecord;
  actions: NoticeAction[];
}

export const DAY_MS = 24 * 60 * 60_000;
/** 默认：主人没参与的连续来回 30 次才暂停（很宽，正常派活几乎碰不到）；0 = 关闭保护。 */
export const DEFAULT_LOOP_PAUSE_AFTER = 30;

/**
 * 适配层提供的环境：
 * - queued：这条通知是否还在派发方队列里没被处理；
 * - pauseAfter：连续来回多少次后暂停（0 = 关闭）；
 * - ownerSpoke：自上次通知以来，主人是否在这个派发方对话里说过话（适配层预先读好）。
 */
export interface CoreEnv {
  queued(target: DispatcherRef, clientId: string): boolean;
  pauseAfter?: number;
  ownerSpoke?(target: DispatcherRef): boolean;
}
export type QueueProbe = CoreEnv | ((target: DispatcherRef, clientId: string) => boolean);

function envOf(probe: QueueProbe): CoreEnv {
  return typeof probe === 'function' ? { queued: probe } : probe;
}

/** 只保留 24 小时内的发送记录（用于合并与撤回）。 */
function prune(record: TaskRecord, now: number): TaskRecord {
  return { ...record, sent: record.sent.filter(entry => now - entry.at < DAY_MS) };
}

function noticeId(taskId: string, kind: NoticeKind, target: DispatcherRef, now: number, extra = ''): string {
  return `dispatcher-notice:${taskId}:${kind}:${target.deviceId}:${target.sessionId}:${now}${extra ? ':' + extra : ''}`;
}

/**
 * 发一条通知给链上所有派发方：合并（同目标同类、还在排队没被处理的旧通知被替换）与来回保护。
 */
function emit(
  record: TaskRecord,
  targets: DispatcherRef[],
  base: Omit<Notice, 'id' | 'target' | 'clientId'>,
  now: number,
  probe: QueueProbe,
): Step {
  const env = envOf(probe);
  let next = prune(record, now);
  const actions: NoticeAction[] = [];
  const bucket = noticeBucket(base.kind);
  // 来回保护：主人在任务里或派发方对话里说过话就清零并恢复。
  const pauseAfter = env.pauseAfter ?? DEFAULT_LOOP_PAUSE_AFTER;
  let loop = next.loop ?? { exchanges: 0, paused: false };
  if (targets.some(target => env.ownerSpoke?.(target))) loop = { exchanges: 0, paused: false };
  if (loop.paused) return { record: { ...next, loop }, actions };
  if (pauseAfter > 0 && loop.exchanges >= pauseAfter) {
    // 达到次数：这条不发普通通知，改发「已暂停」给派发方，并提醒主人；之后等主人介入。
    next = { ...next, loop: { exchanges: loop.exchanges, paused: true, since: now } };
    actions.push({ type: 'owner-alert', reason: 'loop-paused', taskId: record.taskId });
    for (const target of targets) {
      const id = noticeId(record.taskId, 'paused', target, now);
      actions.push({ type: 'deliver', notice: { ...base, kind: 'paused', id, target, clientId: id } });
      next = { ...next, sent: [...next.sent, { id, kind: 'paused', at: now, target, clientId: id }] };
    }
    return { record: next, actions };
  }
  // 「已由用户处理」这类宿主补充说明不算一次来回。
  next = { ...next, loop: { exchanges: loop.exchanges + (base.kind === 'resolved' ? 0 : 1), paused: false } };
  for (const target of targets) {
    const replace = [...next.sent].reverse().find(entry => noticeBucket(entry.kind) === bucket
      && sameDispatcher(entry.target, target) && env.queued(target, entry.clientId)
      && (bucket === 'result' || entry.interactionId === base.interaction?.id));
    const id = noticeId(record.taskId, base.kind, target, now, base.interaction?.id);
    const clientId = replace?.clientId ?? id;
    const notice: Notice = { ...base, id, target, clientId };
    actions.push(replace ? { type: 'deliver', notice, replaceClientId: replace.clientId } : { type: 'deliver', notice });
    const entry: SentNotice = { id, kind: base.kind, at: now, target, clientId,
      ...(base.interaction ? { interactionId: base.interaction.id } : {}) };
    // 替换不新增计数：同一条排队消息只是换了内容。
    next = { ...next, sent: replace
      ? next.sent.map(item => item.clientId === replace.clientId && sameDispatcher(item.target, target) ? entry : item)
      : [...next.sent, entry] };
  }
  return { record: next, actions };
}

/** 只有新建时的派发方可以关掉通知；关掉后它发来的消息不再建立归属。 */
function qualifies(record: TaskRecord, sender: DispatcherRef): boolean {
  const relation = record.relation;
  return !(relation && !relation.notify && sameDispatcher(relation.dispatcher, sender));
}

/** send_to_session 新建任务成功后记下派发关系。 */
export function recordDispatch(record: TaskRecord, dispatcher: DispatcherRef, notify: boolean, now: number): TaskRecord {
  return { ...record, relation: { dispatcher, createdAt: now, notify } };
}

/** 一轮开始：按这一轮处理的输入决定归属。 */
export function onTurnStarted(record: TaskRecord, inputs: readonly TurnInput[], now: number): TaskRecord {
  const owners: DispatcherRef[] = [];
  for (const input of inputs) {
    if (input.kind !== 'dispatcher' || !input.sender || !qualifies(record, input.sender)) continue;
    if (!owners.some(owner => sameDispatcher(owner, input.sender!))) owners.push(input.sender);
  }
  const hasOwnerInput = inputs.some(input => input.kind === 'owner'
    || (input.kind === 'dispatcher' && (!input.sender || !qualifies(record, input.sender))));
  const chain = record.chain;
  // 主人在任务里说话：来回计数清零，暂停解除。
  if (hasOwnerInput && record.loop) record = { ...record, loop: { exchanges: 0, paused: false } };
  if (owners.length) {
    const merged = chain ? [...chain.owners, ...owners.filter(owner => !chain.owners.some(o => sameDispatcher(o, owner)))] : owners;
    return { ...record, chain: {
      owners: merged,
      startedAt: chain?.startedAt ?? now,
      ownerInterjected: (chain?.ownerInterjected ?? false) || hasOwnerInput,
      selfReportedTo: chain?.selfReportedTo ?? [],
      waitingNotified: chain?.waitingNotified ?? [],
      lastTerminal: null,
    } };
  }
  if (!chain) return record;
  // 宿主续跑沿用归属；主人插进来的一轮也还算这串请求（它没停下过），只记一笔。
  return { ...record, chain: { ...chain, lastTerminal: null, ownerInterjected: chain.ownerInterjected || hasOwnerInput } };
}

/** 一轮中途主人（或非派发方）插话。 */
export function onInterjection(record: TaskRecord, input: TurnInput, now: number): TaskRecord {
  if (!record.chain) return input.kind === 'dispatcher' ? onTurnStarted(record, [input], now) : record;
  if (input.kind === 'dispatcher' && input.sender && qualifies(record, input.sender)) {
    return onTurnStarted(record, [input], now);
  }
  if (input.kind === 'continuation') return record;
  return { ...record, chain: { ...record.chain, ownerInterjected: true } };
}

/** 任务这串请求期间自己发消息给了某个对话。 */
export function onSelfReport(record: TaskRecord, target: DispatcherRef): TaskRecord {
  const chain = record.chain;
  if (!chain || !chain.owners.some(owner => sameDispatcher(owner, target))) return record;
  if (chain.selfReportedTo.some(entry => sameDispatcher(entry, target))) return record;
  return { ...record, chain: { ...chain, selfReportedTo: [...chain.selfReportedTo, target] } };
}

/** 任务进入等待（提问 / 选项 / 计划 / 权限）。立即通知，同一次等待只发一次。 */
export function onWaiting(
  record: TaskRecord, interaction: PendingInteraction, now: number,
  queued: QueueProbe,
): Step {
  const chain = record.chain;
  if (!chain || chain.waitingNotified.includes(interaction.id)) return { record, actions: [] };
  const withMark: TaskRecord = { ...record, chain: { ...chain, waitingNotified: [...chain.waitingNotified, interaction.id] } };
  return emit(withMark, chain.owners, {
    kind: 'waiting', taskId: record.taskId, ownerInterjected: chain.ownerInterjected, interaction,
  }, now, queued);
}

/** 等待被处理掉（主人在任务里答了 / 批了，或问题被撤回）。 */
export function onInteractionResolved(
  record: TaskRecord, interactionId: string, now: number,
  queued: QueueProbe,
): Step {
  const notified = record.sent.filter(entry => entry.kind === 'waiting' && entry.interactionId === interactionId);
  if (!notified.length) return { record, actions: [] };
  const actions: NoticeAction[] = [];
  let next = record;
  const env = envOf(queued);
  for (const entry of notified) {
    if (env.queued(entry.target, entry.clientId)) {
      // 还没被派发方处理：直接撤回，不再打扰。撤回的不计入上限。
      actions.push({ type: 'withdraw', target: entry.target, clientId: entry.clientId });
      next = { ...next, sent: next.sent.filter(item => item !== entry) };
      continue;
    }
    // 已经被处理过（派发方可能正在问主人）：补一句「已处理」。
    const step = emit(next, [entry.target], {
      kind: 'resolved', taskId: record.taskId, ownerInterjected: false,
      interaction: { id: interactionId, kind: 'other' },
    }, now, { ...env, queued: () => false });
    next = step.record;
    actions.push(...step.actions);
  }
  return { record: next, actions };
}

export interface StopFacts {
  phase: 'completed' | 'error';
  /** 没有在跑、没有排着的续跑、队列里没有可执行的消息。 */
  settled: boolean;
  error?: string;
  result?: string;
}

/** 一轮停在完成或出错。只有真正停下才发通知并结清这串请求。 */
export function onStopped(
  record: TaskRecord, facts: StopFacts, now: number,
  queued: QueueProbe,
): Step {
  const chain = record.chain;
  if (!chain) return { record, actions: [] };
  if (!facts.settled) {
    return { record: { ...record, chain: { ...chain, lastTerminal: facts.phase,
      ...(facts.error ? { lastError: facts.error } : {}) } }, actions: [] };
  }
  const cleared: TaskRecord = { ...record, chain: null };
  if (facts.phase === 'completed') {
    const targets = chain.owners.filter(owner => !chain.selfReportedTo.some(entry => sameDispatcher(entry, owner)));
    if (!targets.length) return { record: cleared, actions: [] };
    return emit(cleared, targets, { kind: 'done', taskId: record.taskId, ownerInterjected: chain.ownerInterjected,
      ...(facts.result ? { result: facts.result } : {}) }, now, queued);
  }
  return emit(cleared, chain.owners, { kind: 'error', taskId: record.taskId, ownerInterjected: chain.ownerInterjected,
    ...(facts.error ?? chain.lastError ? { error: facts.error ?? chain.lastError } : {}) }, now, queued);
}

/** 主人手动停止：静默结清，不通知。 */
export function onStoppedByOwner(record: TaskRecord): TaskRecord {
  return record.chain ? { ...record, chain: null } : record;
}

/** 派发方的消息在投递前就失败（Agent 起不来等），任务没有开始这一轮。 */
export function onDispatchFailed(
  record: TaskRecord, input: TurnInput, error: string, now: number,
  queued: QueueProbe,
): Step {
  const owners = record.chain?.owners.slice() ?? [];
  if (input.kind === 'dispatcher' && input.sender && qualifies(record, input.sender)
    && !owners.some(owner => sameDispatcher(owner, input.sender!))) owners.push(input.sender);
  if (!owners.length) return { record, actions: [] };
  const interjected = record.chain?.ownerInterjected ?? false;
  return emit({ ...record, chain: null }, owners, {
    kind: 'dispatch-failed', taskId: record.taskId, ownerInterjected: interjected, error,
  }, now, queued);
}

export interface RestartFacts {
  /** 上一轮开始了但没收尾（数据库记录）。 */
  interrupted: boolean;
  /** 宿主已经排了续跑（会接着做）。 */
  resumeQueued: boolean;
  /** 任务当前是否在跑或等待。 */
  active: boolean;
}

/** Cindy 启动后对每个还挂着请求的任务补判一次。 */
export function onRestart(
  record: TaskRecord, facts: RestartFacts, now: number,
  queued: QueueProbe,
): Step {
  const chain = record.chain;
  if (!chain || facts.active || facts.resumeQueued) return { record, actions: [] };
  if (facts.interrupted) {
    return emit({ ...record, chain: null }, chain.owners, {
      kind: 'interrupted', taskId: record.taskId, ownerInterjected: chain.ownerInterjected,
    }, now, queued);
  }
  // 退出前已经停在完成 / 出错但还没来得及判定为真正停下：现在没有续跑，就按最后状态补发。
  if (chain.lastTerminal) {
    return onStopped(record, { phase: chain.lastTerminal, settled: true,
      ...(chain.lastError ? { error: chain.lastError } : {}) }, now, queued);
  }
  return { record, actions: [] };
}

/**
 * 派发方用 send_to_session 的回复被宿主当作对提问的回答交了进去：这条等待已由派发方处理，
 * 之后提问消失时不再发「已由用户处理」，也不撤回。
 */
export function onAnsweredByDispatcher(record: TaskRecord, interactionId: string): TaskRecord {
  return { ...record, sent: record.sent.filter(entry => !(entry.kind === 'waiting' && entry.interactionId === interactionId)) };
}

/** 这次请求期间，派发方可以用普通回复作答的提问：只限这串请求里通知过它的提问类等待，最早的一个。 */
export function answerableQuestion(record: TaskRecord, sender: DispatcherRef, pending: readonly PendingInteraction[]): PendingInteraction | null {
  const chain = record.chain;
  if (!chain || !chain.owners.some(owner => sameDispatcher(owner, sender))) return null;
  return pending.find(item => item.kind === 'question' && chain.waitingNotified.includes(item.id)
    && record.sent.some(entry => entry.kind === 'waiting' && entry.interactionId === item.id && sameDispatcher(entry.target, sender))) ?? null;
}
