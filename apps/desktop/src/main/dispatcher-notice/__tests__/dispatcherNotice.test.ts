/**
 * 测试价值
 * - 生产入口与可观察结果：dispatcher-notice/core.ts 的公开纯函数（onTurnStarted / onStopped / onWaiting /
 *   onInteractionResolved / onRestart / onDispatchFailed / onSelfReport）产生的投递、撤回、主人提醒动作；
 *   noticeText.ts 的通知正文；store.ts 的持久记录。派发方最终看到的就是这些动作与正文。
 * - Bug／规则依据：docs/product-rules/dispatcher-notice.md（派发方通知）。历史事故：伙伴开的任务在宿主
 *   重启后续跑失败，5 小时无人知道——那一轮的输入不带伙伴来源，只按「这一轮是谁触发」判断会漏。
 * - 现有覆盖缺口：新模块，无既有覆盖。
 * - 最小失败输入：伙伴消息一轮出错 → 宿主续跑（continuation）→ 重启后续跑再失败；期望只在真正停下时
 *   给伙伴发一条出错通知。
 * - tier：unit（纯函数 + 临时目录里的真实文件读写，无网络、无子进程）。
 * - 实测耗时：见 PR 描述（本地单独运行 < 1 秒）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  emptyRecord,
  onDispatchFailed,
  onInteractionResolved,
  onRestart,
  onSelfReport,
  onStopped,
  onStoppedByOwner,
  onTurnStarted,
  onWaiting,
  answerableQuestion,
  onAnsweredByDispatcher,
  recordDispatch,
  type DispatcherRef,
  type NoticeAction,
  type TaskRecord,
  type TurnInput,
} from '../core.js';
import { buildNoticeText, LIMITS as TEXT_LIMITS } from '../noticeText.js';
import { createDispatcherNoticeStore, type DispatcherNoticeStore } from '../store.js';
import { createDispatcherNoticeService, type ActivityState, type TargetState } from '../service.js';
import { toPendingInteraction } from '../pendingInteraction.js';
import { mapReplyToAnswers } from '../answerRouting.js';

const BOT: DispatcherRef = { deviceId: 'local', sessionId: 'bot-main', botId: 'bot-1' };
const OTHER_BOT: DispatcherRef = { deviceId: 'local', sessionId: 'bot2-main', botId: 'bot-2' };
const T0 = 1_000_000;
const notQueued = () => false;
const fromBot = (clientId = 'b1', sender = BOT): TurnInput => ({ clientId, kind: 'dispatcher', sender });
const owner = (clientId = 'o1'): TurnInput => ({ clientId, kind: 'owner' });
const resume = (clientId = 'r1'): TurnInput => ({ clientId, kind: 'continuation' });

function delivered(actions: NoticeAction[]) {
  return actions.flatMap(action => action.type === 'deliver' ? [action.notice] : []);
}

describe('which rounds belong to the dispatcher', () => {
  it.each([
    ['dispatcher message only', [fromBot()], true, false],
    ['dispatcher message with owner interjection in the same round', [fromBot(), owner()], true, true],
    ['owner input only', [owner()], false, false],
    ['host continuation without an earlier dispatcher request', [resume()], false, false],
  ] as const)('%s', (_name, inputs, notifies, interjected) => {
    const started = onTurnStarted(emptyRecord('task'), inputs, T0);
    const { actions } = onStopped(started, { phase: 'completed', settled: true, result: 'ok' }, T0 + 1, notQueued);
    const notices = delivered(actions);
    expect(notices.length).toBe(notifies ? 1 : 0);
    if (notifies) expect(notices[0]).toMatchObject({ kind: 'done', target: BOT, ownerInterjected: interjected, result: 'ok' });
  });

  it('a dispatcher that created the task with notify off gets nothing; another teammate still does', () => {
    const record = recordDispatch(emptyRecord('task'), BOT, false, T0);
    expect(delivered(onStopped(onTurnStarted(record, [fromBot()], T0), { phase: 'completed', settled: true }, T0, notQueued).actions)).toEqual([]);
    const other = delivered(onStopped(onTurnStarted(record, [fromBot('x', OTHER_BOT)], T0), { phase: 'completed', settled: true }, T0, notQueued).actions);
    expect(other.map(n => n.target)).toEqual([OTHER_BOT]);
  });
});

describe('follows host continuations until the task really stops (incident sequence)', () => {
  it('error → automatic retries → restart resume → final failure yields one error notice', () => {
    let record = onTurnStarted(emptyRecord('task'), [fromBot()], T0);
    let step = onStopped(record, { phase: 'error', settled: false, error: 'first' }, T0 + 1, notQueued);
    expect(step.actions).toEqual([]);
    record = onTurnStarted(step.record, [resume('r1')], T0 + 2);
    step = onStopped(record, { phase: 'error', settled: false, error: 'second' }, T0 + 3, notQueued);
    // 重启后的续跑输入不带来源，按 continuation 归类，沿用伙伴的归属。
    record = onTurnStarted(step.record, [resume('r2')], T0 + 4);
    step = onStopped(record, { phase: 'error', settled: true, error: 'remote agent lost' }, T0 + 5, notQueued);
    expect(delivered(step.actions)).toEqual([expect.objectContaining({ kind: 'error', target: BOT, error: 'remote agent lost' })]);
    expect(step.record.chain).toBeNull();
  });

  it('owner stop clears silently; a later owner-only round does not notify', () => {
    const stopped = onStoppedByOwner(onTurnStarted(emptyRecord('task'), [fromBot()], T0));
    expect(stopped.chain).toBeNull();
    const later = onStopped(onTurnStarted(stopped, [owner()], T0 + 1), { phase: 'completed', settled: true }, T0 + 2, notQueued);
    expect(later.actions).toEqual([]);
  });
});

describe('restart scan', () => {
  const armed = onTurnStarted(emptyRecord('task'), [fromBot()], T0);
  it.each([
    ['interrupted and no resume queued → interrupted notice', { interrupted: true, resumeQueued: false, active: false }, armed, 'interrupted'],
    ['interrupted but the host queued a resume → wait', { interrupted: true, resumeQueued: true, active: false }, armed, null],
    ['stopped with an error before quitting, not yet settled → error notice',
      { interrupted: false, resumeQueued: false, active: false },
      onStopped(armed, { phase: 'error', settled: false, error: 'boom' }, T0, notQueued).record, 'error'],
    ['still running after restart → wait', { interrupted: false, resumeQueued: false, active: true }, armed, null],
  ] as const)('%s', (_name, facts, record, kind) => {
    const notices = delivered(onRestart(record as TaskRecord, facts, T0 + 10, notQueued).actions);
    expect(notices.map(n => n.kind)).toEqual(kind ? [kind] : []);
  });
});

describe('dedupe, merge and caps', () => {
  it('no done notice when the task already reported back to that dispatcher; errors still notify', () => {
    const reported = onSelfReport(onTurnStarted(emptyRecord('task'), [fromBot()], T0), BOT);
    expect(onStopped(reported, { phase: 'completed', settled: true }, T0, notQueued).actions).toEqual([]);
    expect(delivered(onStopped(reported, { phase: 'error', settled: true }, T0, notQueued).actions)).toHaveLength(1);
  });

  it('a newer notice replaces one still waiting in the dispatcher queue without counting twice', () => {
    const first = onStopped(onTurnStarted(emptyRecord('task'), [fromBot()], T0), { phase: 'completed', settled: true, result: 'v1' }, T0, notQueued);
    const firstClientId = delivered(first.actions)[0].clientId;
    const queued = (_t: DispatcherRef, clientId: string) => clientId === firstClientId;
    const second = onStopped(onTurnStarted(first.record, [fromBot('b2')], T0 + 5), { phase: 'completed', settled: true, result: 'v2' }, T0 + 6, queued);
    expect(second.actions).toEqual([expect.objectContaining({ type: 'deliver', replaceClientId: firstClientId })]);
    expect(second.record.sent).toHaveLength(1);
  });

  // 主人裁决（2026-11-25）：不按天限量；只有派发方与任务连续来回、主人两边都没参与达到设定次数才暂停，且暂停要让主人看得到。
  function exchange(record: TaskRecord, i: number, env: Parameters<typeof onStopped>[3]) {
    return onStopped(onTurnStarted(record, [fromBot(`b${i}`)], T0 + i), { phase: 'completed', settled: true }, T0 + i, env);
  }

  it('no daily cap: many ordinary notices all go out when the pause is off', () => {
    let record = emptyRecord('task');
    const all: NoticeAction[] = [];
    for (let i = 0; i < 50; i++) {
      const step = exchange(record, i, { queued: notQueued, pauseAfter: 0 });
      record = step.record;
      all.push(...step.actions);
    }
    expect(delivered(all)).toHaveLength(50);
    expect(all.filter(a => a.type === 'owner-alert')).toEqual([]);
  });

  it('pauses visibly after N exchanges without the owner, and resumes when the owner speaks', () => {
    let record = emptyRecord('task');
    const all: NoticeAction[] = [];
    for (let i = 0; i < 5; i++) {
      const step = exchange(record, i, { queued: notQueued, pauseAfter: 3 });
      record = step.record;
      all.push(...step.actions);
    }
    expect(delivered(all).map(n => n.kind)).toEqual(['done', 'done', 'done', 'paused']);
    expect(all.filter(a => a.type === 'owner-alert')).toHaveLength(1);
    // 主人在派发方对话里说了话：恢复正常通知。
    const resumed = exchange(record, 9, { queued: notQueued, pauseAfter: 3, ownerSpoke: () => true });
    expect(delivered(resumed.actions).map(n => n.kind)).toEqual(['done']);
    // 主人在任务里说话同样清零。
    const inTask = onStopped(onTurnStarted(record, [fromBot('x'), owner('o')], T0 + 20), { phase: 'completed', settled: true }, T0 + 20,
      { queued: notQueued, pauseAfter: 3 });
    expect(delivered(inTask.actions).map(n => n.kind)).toEqual(['done']);
  });

  it('dispatch failure notifies the sender even though no round started', () => {
    const step = onDispatchFailed(emptyRecord('task'), fromBot(), 'agent not ready', T0, notQueued);
    expect(delivered(step.actions)).toEqual([expect.objectContaining({ kind: 'dispatch-failed', target: BOT, error: 'agent not ready' })]);
    expect(onDispatchFailed(emptyRecord('task'), owner(), 'x', T0, notQueued).actions).toEqual([]);
  });
});

describe('waiting notices', () => {
  const armed = onTurnStarted(emptyRecord('task'), [fromBot()], T0);
  const question = { id: 'q1', kind: 'question' as const, questions: [
    { question: 'Which database should the report use?', options: ['Production replica', 'Staging'] },
  ] };

  it('sends once per interaction with the question text and options', () => {
    const first = onWaiting(armed, question, T0, notQueued);
    const notice = delivered(first.actions)[0];
    const text = buildNoticeText(notice, { title: 'Report', lang: 'en', replyAnswers: true });
    expect(text).toContain('Which database should the report use?');
    expect(text).toContain('Production replica / Staging');
    expect(text).toContain('your next message to it is used as the answer');
    // 不能转接时（例如远程派发方）只请用户到任务里作答，不承诺转接。
    expect(buildNoticeText(notice, { title: 'Report', lang: 'en' })).not.toContain('used as the answer');
    expect(onWaiting(first.record, question, T0 + 1, notQueued).actions).toEqual([]);
  });

  it('permission waits name the action and say the teammate cannot approve; no answer hint', () => {
    const notice = delivered(onWaiting(armed, { id: 'p1', kind: 'permission', title: 'mcp__github__merge_pr' }, T0, notQueued).actions)[0];
    const text = buildNoticeText(notice, { title: 'PR', lang: 'zh' });
    expect(text).toContain('mcp__github__merge_pr');
    expect(text).toContain('你不能代批');
    expect(text).not.toContain('used as the answer');
  });

  it('a wait the owner handled first is withdrawn if still queued, otherwise followed by a short note', () => {
    const waited = onWaiting(armed, question, T0, notQueued);
    const clientId = delivered(waited.actions)[0].clientId;
    const withdrawn = onInteractionResolved(waited.record, 'q1', T0 + 1, (_t, id) => id === clientId);
    expect(withdrawn.actions).toEqual([{ type: 'withdraw', target: BOT, clientId }]);
    const consumed = onInteractionResolved(waited.record, 'q1', T0 + 1, notQueued);
    expect(delivered(consumed.actions).map(n => n.kind)).toEqual(['resolved']);
  });

  it('long question lists are cut to the total limit but keep the closing hints', () => {
    const many = { id: 'q2', kind: 'question' as const, questions: Array.from({ length: 10 }, (_, i) => ({
      question: `Q${i} ` + 'x'.repeat(600), options: ['a', 'b'] })) };
    const notice = delivered(onWaiting(armed, many, T0, notQueued).actions)[0];
    const text = buildNoticeText(notice, { title: 'Long', lang: 'en' });
    expect(Array.from(text).length).toBeLessThanOrEqual(TEXT_LIMITS.waitingTotal);
    expect(text).toContain('get_task_digest(task)');
  });
});

describe('store', () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); });
  const lock = <T,>(_file: string, run: () => Promise<T>) => run();

  it('persists a pending request across instances, drops empty records, and skips corrupt files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatcher-notice-'));
    dirs.push(dir);
    const corrupt: Array<string | null> = [];
    const store = createDispatcherNoticeStore({ dir, lock, onCorrupt: id => corrupt.push(id) });
    await store.update('task', record => onTurnStarted(record, [fromBot()], T0));
    const reopened = createDispatcherNoticeStore({ dir, lock, onCorrupt: id => corrupt.push(id) });
    expect((await reopened.read('task')).chain?.owners).toEqual([BOT]);
    await fs.writeFile(path.join(dir, 'broken.json'), '{not json');
    expect((await reopened.list()).map(r => r.taskId)).toEqual(['task']);
    expect(corrupt).toEqual([null]);
    await reopened.update('task', record => onStoppedByOwner(record));
    expect((await reopened.list()).map(r => r.taskId)).toEqual([]);
  });
});

describe('host service (in-memory fakes)', () => {
  type Row = { rowid: number; clientId: string; content: string; agentMeta: string | null };
  const botMeta = JSON.stringify({ origin: { kind: 'session', senderSessionId: 'bot-main', senderBotId: 'bot-1', displayText: 'x' } });
  const at = (phase: string, extra: Partial<ActivityState> = {}): ActivityState => ({ phase, startedAtMs: T0, currentTurnActive: false, ...extra });
  const running = at('running', { currentTurnActive: true });

  function harness(options: { target?: TargetState; settled?: boolean } = {}) {
    const records = new Map<string, TaskRecord>();
    const store: DispatcherNoticeStore = {
      read: async id => records.get(id) ?? emptyRecord(id),
      update: async (id, change) => {
        const next = change(records.get(id) ?? emptyRecord(id));
        if (next) records.set(id, next); else records.delete(id);
        return next;
      },
      list: async () => [...records.values()],
      remove: async id => { records.delete(id); },
    };
    const rows: Row[] = [];
    const delivered: Array<{ target: string; text: string; clientId: string }> = [];
    const alerts: string[] = [];
    const queuedIds = new Set<string>();
    const answered: Array<{ requestId: string; answers: Record<string, string> }> = [];
    const state = { settled: options.settled ?? true, pending: [] as unknown[], interrupted: false };
    const service = createDispatcherNoticeService({
      now: () => T0,
      store,
      log: { info: () => undefined, warn: () => undefined },
      language: () => 'en',
      readInputRows: async (_id, after) => rows.filter(row => after === null || row.rowid > after),
      readTaskTitle: async () => 'Build report',
      isTaskLive: async () => true,
      readResult: async () => 'All done',
      readLastError: async () => 'remote agent lost',
      readInterrupted: async () => state.interrupted,
      pendingInteractions: () => state.pending.flatMap(item => { const parsed = toPendingInteraction(item); return parsed ? [parsed] : []; }),
      isSettled: () => state.settled,
      isResumeQueued: async () => false,
      answerQuestion: async (_task, requestId, answers) => {
        answered.push({ requestId, answers });
        state.pending = [];
        return true;
      },
      isActive: () => false,
      targetState: async () => options.target ?? 'available',
      queue: {
        isQueued: (_target, id) => queuedIds.has(id),
        deliver: async ({ target, clientId, text }) => {
          delivered.push({ target: target.sessionId, text, clientId });
          queuedIds.add(clientId);
          return true;
        },
        replace: () => false,
        withdraw: (_target, id) => { queuedIds.delete(id); },
      },
      alertOwner: ({ body }) => { alerts.push(body); },
    });
    return { service, rows, delivered, alerts, queuedIds, state, records, answered };
  }

  it.each(['available', 'unavailable'] as const)('settled request with dispatcher %s: deliver to it or alert the owner', async (target) => {
    const h = harness({ target });
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('completed') });
    if (target === 'available') {
      expect(h.delivered).toEqual([expect.objectContaining({ target: 'bot-main' })]);
      expect(h.delivered[0].text).toContain('All done');
      expect(h.alerts).toEqual([]);
    } else {
      expect(h.delivered).toEqual([]);
      expect(h.alerts).toHaveLength(1);
    }
  });

  it('waits while the host still owns a retry, then reports once the queue projection shows it settled', async () => {
    const h = harness({ settled: false });
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('error') });
    expect(h.delivered).toEqual([]);
    expect(h.service.hasOpenRequest('task')).toBe(true);
    h.state.settled = true;
    await h.service.onProjection({ sessionId: 'task', error: null, failedHead: null });
    expect(h.delivered.map(d => d.text)).toEqual([expect.stringContaining('remote agent lost')]);
    expect(h.service.hasOpenRequest('task')).toBe(false);
  });

  it('a teammate message that fails before dispatch is reported from the queue projection, once', async () => {
    const h = harness();
    const facts = { sessionId: 'task', error: 'Agent did not start', failedHead: { clientId: 'b1', content: 'do it', agentMeta: botMeta } };
    await h.service.onProjection(facts);
    await h.service.onProjection(facts);
    expect(h.delivered.map(d => d.text)).toEqual([expect.stringContaining('Agent did not start')]);
  });

  it('owner-only rounds on an unrelated task create no record and no notice', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'o1', content: 'my own request', agentMeta: null });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('completed') });
    expect(h.records.size).toBe(0);
    expect(h.delivered).toEqual([]);
  });

  it('a waiting question is delivered immediately and withdrawn when the owner answers first', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    h.state.pending = [{ request: { kind: 'ask_user_question', requestId: 'q1',
      questions: [{ question: 'Which month?', options: [{ label: 'October' }, { label: 'November' }] }] } }];
    const waiting = at('needs-interaction', { currentTurnActive: true, interactionKind: 'ask_user_question' });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: waiting });
    expect(h.delivered[0].text).toContain('October / November');
    h.state.pending = [];
    await h.service.onActivity({ sessionId: 'task', previous: waiting, current: running });
    expect(h.queuedIds.has(h.delivered[0].clientId)).toBe(false);
  });

  it('restart scan reports an interrupted request once; progress-only snapshot changes are ignored', async () => {
    const h = harness();
    await h.service.noteTaskCreated('task', BOT);
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', previous: running,
      current: at('needs-interaction', { currentTurnActive: true, interactionKind: 'permission' }) });
    h.delivered.length = 0;
    await h.service.onActivity({ sessionId: 'task', previous: running, current: running });
    h.state.interrupted = true;
    await h.service.restartScan();
    await h.service.restartScan();
    expect(h.delivered.map(d => d.text)).toEqual([expect.stringContaining('interrupted')]);
  });

  it('the teammate reply is submitted as the answer, and no "handled by the user" note follows', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    h.state.pending = [{ request: { kind: 'ask_user_question', requestId: 'q1',
      questions: [{ question: 'Which month?', options: [{ label: 'October' }, { label: 'November' }] }] } }];
    const waiting = at('needs-interaction', { currentTurnActive: true, interactionKind: 'ask_user_question' });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: waiting });
    // 别的伙伴的回复不转接。
    expect(await h.service.routeReply('task', OTHER_BOT, 'October')).toBeNull();
    expect(await h.service.routeReply('task', BOT, '2')).toEqual({ answered: true, requestId: 'q1' });
    expect(h.answered).toEqual([{ requestId: 'q1', answers: { 'Which month?': 'November' } }]);
    h.delivered.length = 0;
    await h.service.onActivity({ sessionId: 'task', previous: waiting, current: running });
    expect(h.delivered).toEqual([]);
  });

  it('owner stop while the request is open clears it silently', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', previous: running,
      current: at('needs-interaction', { currentTurnActive: true, interactionKind: 'plan_review' }) });
    h.delivered.length = 0;
    await h.service.onActivity({ sessionId: 'task', previous: running, current: null });
    expect(h.service.hasOpenRequest('task')).toBe(false);
    expect(h.delivered).toEqual([]);
  });

  it('classifies restart resumes stored as {"text": "[UI_ACTION_TRIGGER] ..."} as continuations', async () => {
    const h = harness({ settled: false });
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('error') });
    h.rows.push({ rowid: 2, clientId: 'r1', content: JSON.stringify({ text: '[UI_ACTION_TRIGGER] The previous turn was interrupted' }), agentMeta: '{}' });
    h.state.settled = true;
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('error', { startedAtMs: T0 + 5 }) });
    expect(h.delivered.map(d => d.target)).toEqual(['bot-main']);
    // 归成主人输入的话会带「用户也发过消息」的提示；续跑不应带。
    expect(h.delivered[0].text).not.toContain('also sent messages');
  });
});

describe('a teammate reply answers the pending question (host routing, no extra tool)', () => {
  const q = (extra: Record<string, unknown> = {}) => ({ question: 'Which month?', options: [{ label: 'October' }, { label: 'November' }], ...extra });

  it.each([
    ['option name, any case', [q()], 'november', { 'Which month?': 'November' }],
    ['option number', [q()], '1', { 'Which month?': 'October' }],
    ['free text becomes the typed answer', [q()], 'Use the fiscal month instead', { 'Which month?': 'Use the fiscal month instead' }],
    ['multi-select by names', [q({ multiSelect: true })], 'October, November', { 'Which month?': JSON.stringify(['October', 'November']) }],
    ['several questions answered line by line', [q({ id: 'm' }), { id: 'y', question: 'Which year?' }], '1. October\n2. 2026', { m: 'October', y: '2026' }],
    ['several questions without numbering get the whole reply each', [q({ id: 'm' }), { id: 'y', question: 'Which year?' }], 'October 2026',
      { m: 'October 2026', y: 'October 2026' }],
  ] as const)('%s', (_name, questions, reply, answers) => {
    expect(mapReplyToAnswers(questions as never, reply)).toEqual({ ok: true, answers });
  });

  it('a fixed-choice question that the reply does not match is not answered', () => {
    expect(mapReplyToAnswers([q({ answerConstraints: { required: true, choices: ['October', 'November'] } })] as never, 'December'))
      .toEqual({ ok: false, reason: 'choice-required', choices: ['October', 'November'] });
  });

  it('only questions notified to that teammate in its own request are answerable; permissions never are', () => {
    const armed = onTurnStarted(emptyRecord('task'), [fromBot()], T0);
    const asked = onWaiting(armed, { id: 'q1', kind: 'question', questions: [{ question: 'Which month?', options: ['October'] }] }, T0, notQueued).record;
    const withPermission = onWaiting(asked, { id: 'p1', kind: 'permission', title: 'Bash' }, T0, notQueued).record;
    const pending = [{ id: 'p1', kind: 'permission' as const }, { id: 'q1', kind: 'question' as const, questions: [] }];
    expect(answerableQuestion(withPermission, BOT, pending)?.id).toBe('q1');
    expect(answerableQuestion(withPermission, OTHER_BOT, pending)).toBeNull();
    expect(answerableQuestion(withPermission, BOT, [pending[0]])).toBeNull();
    // 派发方答过之后，提问消失时不再补「已由用户处理」。
    const answered = onAnsweredByDispatcher(withPermission, 'q1');
    expect(onInteractionResolved(answered, 'q1', T0 + 1, notQueued).actions).toEqual([]);
  });
});
