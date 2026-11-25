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
  DAY_MS,
  emptyRecord,
  LIMITS,
  onDispatchFailed,
  onInteractionResolved,
  onRestart,
  onSelfReport,
  onStopped,
  onStoppedByOwner,
  onTurnStarted,
  onWaiting,
  recordDispatch,
  type DispatcherRef,
  type NoticeAction,
  type TaskRecord,
  type TurnInput,
} from '../core.js';
import { buildNoticeText, LIMITS as TEXT_LIMITS } from '../noticeText.js';
import { createDispatcherNoticeStore } from '../store.js';

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

  it('caps each bucket per day, alerts the owner once, and resets after a day', () => {
    let record = emptyRecord('task');
    const all: NoticeAction[] = [];
    for (let i = 0; i <= LIMITS.result + 1; i++) {
      const step = onStopped(onTurnStarted(record, [fromBot(`b${i}`)], T0 + i), { phase: 'completed', settled: true }, T0 + i, notQueued);
      record = step.record;
      all.push(...step.actions);
    }
    expect(delivered(all)).toHaveLength(LIMITS.result);
    expect(all.filter(a => a.type === 'owner-alert')).toHaveLength(1);
    // 等待类有独立额度，结果类超限不影响提问通知。
    const waiting = onWaiting(onTurnStarted(record, [fromBot('w')], T0 + 20), { id: 'q1', kind: 'question', questions: [] }, T0 + 20, notQueued);
    expect(delivered(waiting.actions)).toHaveLength(1);
    const nextDay = onStopped(onTurnStarted(record, [fromBot('n')], T0 + DAY_MS + 10), { phase: 'completed', settled: true }, T0 + DAY_MS + 10, notQueued);
    expect(delivered(nextDay.actions)).toHaveLength(1);
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
    expect(text).toContain('answer_session_question');
    expect(onWaiting(first.record, question, T0 + 1, notQueued).actions).toEqual([]);
  });

  it('permission waits name the action and say the teammate cannot approve; no answer hint', () => {
    const notice = delivered(onWaiting(armed, { id: 'p1', kind: 'permission', title: 'mcp__github__merge_pr' }, T0, notQueued).actions)[0];
    const text = buildNoticeText(notice, { title: 'PR', lang: 'zh' });
    expect(text).toContain('mcp__github__merge_pr');
    expect(text).toContain('你不能代批');
    expect(text).not.toContain('answer_session_question');
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
