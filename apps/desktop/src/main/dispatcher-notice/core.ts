/**
 * 派发方通知 · 纯逻辑（不碰 IO / 模型 / Electron）。
 *
 * 伙伴（或派发方任务）发来的请求，由宿主在任务真正停下时通知派发方；任务里的 Agent 不参与。
 * 规则（docs/product-rules/dispatcher-notice.md）：
 * - 一轮处理过的输入里只要有派发方的消息，这一轮就归派发方；主人插话不改变归属。
 * - 宿主自己的续跑（出错重试、重启后接着做、用量恢复）沿用上一轮的归属。
 * - 只有主人（或其它非派发方来源）输入的轮次不建立归属。
 * - 任务真正停下（没有在跑、没有排着的续跑、队列里没有可执行的消息）才发「完成 / 出错」。
 * - 提问（问题、让选选项）：这串请求归派发方且主人没插过话时，宿主不弹卡片，直接转交派发方（转交即通知），
 *   任务这一轮结束；之后很快停下时不再另发「完成」。其余情况照旧弹卡片给主人，并通知派发方在等主人作答。
 * - 计划确认、权限审批：只能主人处理，立即通知派发方在等什么；主人先处理掉就撤回或补一句。
 * - 主人手动停止：静默结清。
 * - 任务这串请求期间已自己发回派发方：不再发「完成」，出错与等待照发。
 * - 不设任何上限或来回熔断（主人 2026-11-25 决定：出现转圈再说）。每条投递都记一行日志
 *   （任务、发给谁、哪种状态、时间，不记正文），以后要加保护，加在 emit() 一处即可。
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
 * - owner：主人亲自输入（没有来源标记）——会清零来回计数，在请求中途出现时算「主人插话」；
 * - other：其它不建立归属的来源（定时任务、插件、普通任务之间互发等）——既不清零也不算主人插话。
 */
export type TurnInputKind = 'dispatcher' | 'continuation' | 'owner' | 'other';

export interface TurnInput {
  clientId: string;
  kind: TurnInputKind;
  sender?: DispatcherRef;
}

export type NoticeKind = 'done' | 'error' | 'interrupted' | 'dispatch-failed' | 'waiting' | 'resolved';
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
  /** 这条等待通知是宿主转交的提问：问题由宿主自己在任务里答掉，之后任务里的问题消失不代表主人处理了。 */
  forwarded?: true;
}

export interface Chain {
  owners: DispatcherRef[];
  startedAt: number;
  ownerInterjected: boolean;
  /** 本串请求期间，任务自己已发回的派发方。 */
  selfReportedTo: DispatcherRef[];
  /** 已经通知过的等待（交互 id）。 */
  waitingNotified: string[];
  /** 宿主把提问转交派发方的时刻；随后很快停下时不再另发「完成」。 */
  forwardedAt?: number;
  /** 最近一次回合终态；用于重启后补判。 */
  lastTerminal: 'completed' | 'error' | null;
  lastError?: string;
  /**
   * 重启后已经报过「被打断」。Cindy 重启后不自动接着做，而是弹窗问主人；主人点「继续」开的续跑
   * 仍是这串请求，结束时照常通知派发方。主人自己另起的一轮不算，归属在那时结清。
   */
  interruptedNotified?: true;
}

export interface TaskRecord {
  taskId: string;
  /** send_to_session 新建任务时记下的派发关系；常驻到任务归档或删除。 */
  relation: { dispatcher: DispatcherRef; createdAt: number; notify: boolean } | null;
  chain: Chain | null;
  /** 最近 24 小时发过的通知。 */
  sent: SentNotice[];
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
  /** 提问已由宿主转交派发方（任务这一轮已结束，等派发方回复）。 */
  forwarded?: boolean;
}

export type NoticeAction =
  /** 投递一条通知；replaceClientId 指向同一目标还没被处理的旧通知，适配层能替换就替换。 */
  | { type: 'deliver'; notice: Notice; replaceClientId?: string }
  /** 撤回还在派发方队列里没被处理的通知。 */
  | { type: 'withdraw'; target: DispatcherRef; clientId: string };

export interface Step {
  record: TaskRecord;
  actions: NoticeAction[];
}

export const DAY_MS = 24 * 60 * 60_000;
/** 转交提问后这么久之内停下，算「按转交结束了这一轮」，不再另发「完成」；更久说明它没等回复、接着干了。 */
export const FORWARD_QUIET_MS = 2 * 60_000;

/** 适配层提供的环境：queued = 这条通知是否还在派发方队列里没被处理。 */
export interface CoreEnv {
  queued(target: DispatcherRef, clientId: string): boolean;
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
 * 发一条通知给链上所有派发方：合并（同目标同类、还在排队没被处理的旧通知被替换）。
 * 没有上限或来回熔断（主人 2026-11-25 决定）；以后要加，只需在这里按记录决定发不发。
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
  for (const target of targets) {
    const replace = [...next.sent].reverse().find(entry => noticeBucket(entry.kind) === bucket
      && sameDispatcher(entry.target, target) && env.queued(target, entry.clientId)
      && (bucket === 'result' || entry.interactionId === base.interaction?.id));
    const id = noticeId(record.taskId, base.kind, target, now, base.interaction?.id);
    const clientId = replace?.clientId ?? id;
    const notice: Notice = { ...base, id, target, clientId };
    actions.push(replace ? { type: 'deliver', notice, replaceClientId: replace.clientId } : { type: 'deliver', notice });
    const entry: SentNotice = { id, kind: base.kind, at: now, target, clientId,
      ...(base.interaction ? { interactionId: base.interaction.id } : {}),
      ...(base.forwarded ? { forwarded: true as const } : {}) };
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
  const hasOwnerInput = inputs.some(input => input.kind === 'owner');
  const chain = record.chain;
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
  if (chain.interruptedNotified) {
    // 报过被打断：只有续跑（主人在弹窗或横幅里点「继续」）接上这串请求；主人另起的一轮不再归派发方。
    if (!inputs.some(input => input.kind === 'continuation')) return { ...record, chain: null };
    const resumed: Chain = { ...chain, lastTerminal: null, ownerInterjected: chain.ownerInterjected || hasOwnerInput };
    delete resumed.interruptedNotified;
    return { ...record, chain: resumed };
  }
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

/**
 * 这个提问能不能转交派发方：这串请求归唯一的派发方、主人没插过话，而且派发方是伙伴（带伙伴身份）。
 * 普通任务开出的任务不转交：普通任务不会替主人转述，问题会落空。
 */
export function forwardTarget(record: TaskRecord): DispatcherRef | null {
  const chain = record.chain;
  if (!chain || chain.ownerInterjected || chain.owners.length !== 1) return null;
  const owner = chain.owners[0]!;
  return owner.botId ? owner : null;
}

/** 宿主把提问转交派发方：转交本身就是等待通知；记下时刻，这一轮随后停下时不再另发「完成」。 */
export function onQuestionForwarded(
  record: TaskRecord, interaction: PendingInteraction, now: number, queued: QueueProbe,
): Step {
  const chain = record.chain;
  if (!chain) return { record, actions: [] };
  const marked: TaskRecord = { ...record, chain: { ...chain, forwardedAt: now,
    waitingNotified: [...chain.waitingNotified, interaction.id] } };
  return emit(marked, chain.owners, {
    kind: 'waiting', taskId: record.taskId, ownerInterjected: false, interaction, forwarded: true,
  }, now, queued);
}

/** 等待被处理掉（主人在任务里答了 / 批了，或问题被撤回）。 */
export function onInteractionResolved(
  record: TaskRecord, interactionId: string, now: number,
  queued: QueueProbe,
): Step {
  // 转交的提问由宿主在任务里直接答掉（告诉任务已转交），问题随即消失：这不是主人处理了，
  // 不补「已处理」，也不撤回还在排队的转交——那是派发方唯一能看到问题的地方。
  const matching = record.sent.filter(entry => entry.kind === 'waiting' && entry.interactionId === interactionId);
  if (!matching.length) return { record, actions: [] };
  // 每个等待只结一次：处理完就从记录里拿掉，之后每次停下复查不会再补「已处理」。
  let next: TaskRecord = { ...record, sent: record.sent.filter(entry => !matching.includes(entry)) };
  const notified = matching.filter(entry => !entry.forwarded);
  const actions: NoticeAction[] = [];
  const env = envOf(queued);
  for (const entry of notified) {
    if (env.queued(entry.target, entry.clientId)) {
      // 还没被派发方处理：直接撤回，不再打扰。
      actions.push({ type: 'withdraw', target: entry.target, clientId: entry.clientId });
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
  // 按转交结束了这一轮：转交那条就是给派发方的通知，不再另发「完成」。
  if (facts.phase === 'completed' && chain.forwardedAt !== undefined && now - chain.forwardedAt <= FORWARD_QUIET_MS) {
    return { record: cleared, actions: [] };
  }
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
    // 每次被打断只报一次（之后每次重启扫描都还会看到它没收尾）；归属留着，等主人决定是否继续。
    if (chain.interruptedNotified) return { record, actions: [] };
    return emit({ ...record, chain: { ...chain, interruptedNotified: true } }, chain.owners, {
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

