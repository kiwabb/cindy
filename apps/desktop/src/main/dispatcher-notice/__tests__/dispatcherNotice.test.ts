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
  forwardTarget,
  onQuestionForwarded,
  FORWARD_QUIET_MS,
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

  // 主人决定（2026-11-25）：不设任何上限或来回熔断，正常通知一条都不吞。
  it('no cap: many back-and-forth notices all go out', () => {
    let record = emptyRecord('task');
    const all: NoticeAction[] = [];
    for (let i = 0; i < 50; i++) {
      const step = onStopped(onTurnStarted(record, [fromBot(`b${i}`)], T0 + i), { phase: 'completed', settled: true }, T0 + i, notQueued);
      record = step.record;
      all.push(...step.actions);
    }
    expect(delivered(all)).toHaveLength(50);
    expect(all.every(a => a.type === 'deliver')).toBe(true);
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
    const text = buildNoticeText(notice, { title: 'Report', lang: 'en' });
    expect(text).toContain('Which database should the report use?');
    expect(text).toContain('Production replica / Staging');
    // 没转交（卡片留给用户）时只请伙伴提醒用户到任务里作答。
    expect(text).toContain('Remind the user to answer in the task');
    expect(onWaiting(first.record, question, T0 + 1, notQueued).actions).toEqual([]);
  });

  it('permission waits name the action and say the teammate cannot approve; no answer hint', () => {
    const notice = delivered(onWaiting(armed, { id: 'p1', kind: 'permission', title: 'mcp__github__merge_pr' }, T0, notQueued).actions)[0];
    const text = buildNoticeText(notice, { title: 'PR', lang: 'zh' });
    expect(text).toContain('mcp__github__merge_pr');
    expect(text).toContain('你不能代批');
    expect(text).not.toContain('send_to_session');
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

  function harness(options: { target?: TargetState; settled?: boolean; eligible?: boolean } = {}) {
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
      isActive: () => false,
      isEligibleTask: async () => options.eligible ?? true,
      turnStartedAt: () => T0,
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
    return { service, rows, delivered, alerts, queuedIds, state, records };
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

  // 以下几条都从「一轮刚开始」出发，不预先建立归属：归属必须在开始时就判定好。
  const started = { previous: at('idle'), current: running };

  it('a task that reports back mid-round gets no "done" notice', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', ...started });
    await h.service.noteTaskMessage('task', BOT);
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('completed') });
    expect(h.delivered).toEqual([]);
  });

  it('a first round interrupted by a restart is reported by the restart scan', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', ...started });
    h.state.interrupted = true;
    await h.service.restartScan();
    expect(h.delivered.map(d => d.text)).toEqual([expect.stringContaining('interrupted')]);
  });

  it('after the owner stops a teammate round, the next owner-only round does not notify the teammate', async () => {
    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', ...started });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: null });
    h.rows.push({ rowid: 2, clientId: 'o1', content: 'my own follow-up', agentMeta: null });
    await h.service.onActivity({ sessionId: 'task', previous: at('idle'), current: at('running', { currentTurnActive: true, startedAtMs: T0 + 9 }) });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('completed') });
    expect(h.delivered).toEqual([]);
  });

  it('teammate messages to an ineligible task (another teammate chat, Orca, review) create nothing', async () => {
    const h = harness({ eligible: false });
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'hi', agentMeta: botMeta });
    await h.service.onActivity({ sessionId: 'task', ...started });
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('completed') });
    expect(h.records.size).toBe(0);
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

  describe('questions in a teammate request go to the teammate instead of stopping the task', () => {
  const question = { id: 'q1', kind: 'question' as const, questions: [{ question: 'Which month?', options: ['October', 'November'] }] };

  it.each([
    ['teammate request, owner not involved', [fromBot()], true],
    ['owner interjected in this request', [fromBot(), owner()], false],
    ['owner-only round', [owner()], false],
    ['two teammates in one request (ambiguous)', [fromBot(), fromBot('b2', OTHER_BOT)], false],
    // 普通任务（没有伙伴身份）开出的任务：不转交，问题照旧给主人。
    ['plain task dispatcher without a teammate identity', [fromBot('p1', { deviceId: 'local', sessionId: 'plain-task' })], false],
  ] as const)('%s', (_name, inputs, forwards) => {
    const record = onTurnStarted(emptyRecord('task'), inputs, T0);
    expect(forwardTarget(record) !== null).toBe(forwards);
  });

  it('the forward is the notice; a round that ends soon after sends no extra "done", one that keeps working does', () => {
    const armed = onTurnStarted(emptyRecord('task'), [fromBot()], T0);
    const forwarded = onQuestionForwarded(armed, question, T0, notQueued);
    const notice = delivered(forwarded.actions)[0];
    expect(notice).toMatchObject({ kind: 'waiting', forwarded: true, target: BOT });
    const text = buildNoticeText(notice, { title: 'Report', lang: 'en' });
    expect(text).toContain('October / November');
    expect(text).toContain('send_to_session');
    expect(onStopped(forwarded.record, { phase: 'completed', settled: true }, T0 + 30_000, notQueued).actions).toEqual([]);
    const kept = onStopped(forwarded.record, { phase: 'completed', settled: true }, T0 + FORWARD_QUIET_MS + 1, notQueued);
    expect(delivered(kept.actions).map(n => n.kind)).toEqual(['done']);
  });

  it('service: forwards a teammate question, falls back to the card when the teammate is unavailable', async () => {
    for (const target of ['available', 'unavailable'] as const) {
      const h = harness({ target });
      h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
      expect(await h.service.forwardQuestion('task', question)).toBe(target === 'available');
      expect(h.delivered).toHaveLength(target === 'available' ? 1 : 0);
      // 退回卡片时不给主人另发「派发方不可用」提醒（卡片本身就在主人面前）。
      expect(h.alerts).toEqual([]);
    }
  });

  it('service: an owner question is never forwarded, and a forwarded round that ends right away sends no "done"', async () => {
    const owned = harness();
    owned.rows.push({ rowid: 1, clientId: 'o1', content: 'my question', agentMeta: null });
    expect(await owned.service.forwardQuestion('task', question)).toBe(false);

    const h = harness();
    h.rows.push({ rowid: 1, clientId: 'b1', content: 'do it', agentMeta: botMeta });
    expect(await h.service.forwardQuestion('task', question)).toBe(true);
    await h.service.onActivity({ sessionId: 'task', previous: running, current: at('completed') });
    expect(h.delivered).toHaveLength(1);
  });
});
});
