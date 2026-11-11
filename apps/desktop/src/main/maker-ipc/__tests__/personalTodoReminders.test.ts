/**
 * Protects the personal todo reminder contract: which todos are announced when, that a re-read
 * never repeats a toast, that editing a deadline re-arms it, that a long absence collapses to one
 * summary, and that the runtime records sent reminders even while desktop notifications are off.
 * Tier: unit, injected clock, no timers.
 */
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {},
  powerMonitor: { on() {}, removeListener() {} },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../appSessionState.js', () => ({}));
vi.mock('../../deepLink.js', () => ({ openMainWindowTodos: () => undefined }));
vi.mock('../../i18n.desktop.js', () => ({ t: (key: string) => key }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
vi.mock('../../notificationService.js', () => ({ getDesktopNotificationsEnabled: () => true }));
vi.mock('../personalTodoAccess.js', () => ({
  onPersonalTodosChanged: () => () => {},
  openPersonalTodoStore: () => ({}),
  PERSONAL_TODO_FILE: 'x',
}));

const { createPersonalTodoReminderRuntime, dueReminders, planReminderToasts, reminderLabelKey } = await import(
  '../personalTodoReminders'
);

const DAY = 86_400_000;
const todo = (id: string, patch: Partial<TeammateTodo> = {}): TeammateTodo =>
  ({
    id,
    title: `todo ${id}`,
    status: 'open',
    decision: null,
    sourceDeadline: null,
    ...patch,
  }) as TeammateTodo;
const instant = (at: string) => ({ kind: 'instant' as const, date: at.slice(0, 10), timeZone: 'UTC', at });
const date = (d: string, timeZone: string) => ({ kind: 'date' as const, date: d, timeZone });
const ids = (r: ReturnType<typeof dueReminders>) => r.map((x) => x.id);

describe('dueReminders', () => {
  it('fires a date deadline at 09:00 in the deadline zone, including a DST day', () => {
    const cases: Array<[string, string, string]> = [
      ['2026-03-10', 'Asia/Shanghai', '2026-03-10T01:00:00Z'],
      ['2026-11-02', 'America/New_York', '2026-11-02T14:00:00Z'],
      ['2026-03-08', 'America/New_York', '2026-03-08T13:00:00Z'], // spring-forward already happened at 02:00
    ];
    for (const [d, zone, utc] of cases) {
      const todos = [todo('a', { sourceDeadline: date(d, zone) })];
      const at = Date.parse(utc);
      expect(dueReminders({ todos, now: at - 1, sent: {} })).toEqual([]);
      expect(ids(dueReminders({ todos, now: at, sent: {} }))).toEqual(['a']);
    }
  });

  it('fires an instant deadline at its moment and prefers the owner override over the source deadline', () => {
    const at = '2026-05-01T08:30:00Z';
    const todos = [
      todo('a', { sourceDeadline: date('2030-01-01', 'UTC'), deadlineOverride: { value: instant(at) } }),
    ];
    expect(dueReminders({ todos, now: Date.parse(at) - 1, sent: {} })).toEqual([]);
    expect(dueReminders({ todos, now: Date.parse(at), sent: {} })[0]).toMatchObject({ id: 'a', kind: 'due' });
  });

  it('skips done, deleted, muted and still-deferred todos, and fires when a deferral ends', () => {
    const at = '2026-05-01T08:00:00Z';
    const now = Date.parse(at) + 60_000;
    const deadline = { sourceDeadline: instant(at) };
    const todos = [
      todo('done', { ...deadline, status: 'done' }),
      todo('deleted', { ...deadline, decision: { kind: 'deleted' } }),
      todo('muted', { ...deadline, decision: { kind: 'muted' } }),
      todo('deferred', { ...deadline, decision: { kind: 'later', until: new Date(now + 1000).toISOString() } }),
      todo('ended', { decision: { kind: 'later', until: new Date(now - 1000).toISOString() } }),
    ];
    expect(dueReminders({ todos, now, sent: {} })).toMatchObject([{ id: 'ended', kind: 'resumed' }]);
  });

  it('does not repeat after a re-read and re-arms when the deadline is edited', () => {
    const first = '2026-05-01T08:00:00Z';
    const now = Date.parse(first) + 60_000;
    const sent: Record<string, { id: string; at: number }> = {};
    const [reminder] = dueReminders({ todos: [todo('a', { sourceDeadline: instant(first) })], now, sent });
    for (const k of reminder.keys) sent[k.key] = { id: 'a', at: k.at };
    const reread = [todo('a', { sourceDeadline: instant(first), revision: 9 })];
    expect(dueReminders({ todos: reread, now: now + 5000, sent })).toEqual([]);
    const moved = [todo('a', { sourceDeadline: instant('2026-05-01T08:00:30Z') })];
    expect(ids(dueReminders({ todos: moved, now: now + 5000, sent }))).toEqual(['a']);
  });

  it('honors the reminder setting: off, before-15m, before-1d, and re-arms when it changes', () => {
    const at = '2026-05-01T08:00:00Z';
    const deadline = Date.parse(at);
    const withSetting = (reminder?: TeammateTodo['reminder']) => [
      todo('a', { sourceDeadline: instant(at), ...(reminder ? { reminder } : {}) }),
    ];
    // off: no deadline reminder at all, but a deferral end still fires
    expect(dueReminders({ todos: withSetting('off'), now: deadline + 60_000, sent: {} })).toEqual([]);
    const deferred = [todo('a', { sourceDeadline: instant(at), reminder: 'off', decision: { kind: 'later', until: '2026-05-01T07:00:00Z' } as TeammateTodo['decision'] })];
    expect(dueReminders({ todos: deferred, now: deadline + 60_000, sent: {} })[0]).toMatchObject({ kind: 'resumed' });
    // before-15m fires 15 minutes ahead, not earlier, with the "soon" label
    const early = deadline - 15 * 60_000;
    expect(dueReminders({ todos: withSetting('before-15m'), now: early - 1, sent: {} })).toEqual([]);
    const [soon] = dueReminders({ todos: withSetting('before-15m'), now: early, sent: {} });
    expect(soon).toMatchObject({ id: 'a', kind: 'due', at: early, reminder: 'before-15m' });
    expect(reminderLabelKey(soon)).toBe('personalTodos.reminder.dueSoon');
    // before-1d on a date deadline counts from 09:00 in the deadline zone
    const dated = [todo('d', { sourceDeadline: date('2026-03-10', 'Asia/Shanghai'), reminder: 'before-1d' })];
    const dayBefore = Date.parse('2026-03-09T01:00:00Z');
    expect(dueReminders({ todos: dated, now: dayBefore - 1, sent: {} })).toEqual([]);
    const [tomorrow] = dueReminders({ todos: dated, now: dayBefore, sent: {} });
    expect(tomorrow).toMatchObject({ at: dayBefore, reminder: 'before-1d' });
    expect(reminderLabelKey(tomorrow)).toBe('personalTodos.reminder.dueTomorrow');
    expect(reminderLabelKey({ kind: 'due', reminder: 'default' })).toBe('personalTodos.reminder.due');
    // changing the setting before the deadline re-arms; a re-read of the same setting does not repeat
    const sent: Record<string, { id: string; at: number }> = {};
    for (const k of soon.keys) sent[k.key] = { id: 'a', at: k.at };
    expect(dueReminders({ todos: withSetting('before-15m'), now: early + 1000, sent })).toEqual([]);
    const switched = dueReminders({ todos: withSetting('before-1h'), now: deadline - 30 * 60_000, sent });
    expect(switched[0]).toMatchObject({ reminder: 'before-1h', at: deadline - 3_600_000 });
    // after the plain due reminder was announced, moving to an early setting does not announce again
    const plain = dueReminders({ todos: withSetting(), now: deadline + 1000, sent: {} })[0];
    const sentPlain: Record<string, { id: string; at: number }> = {};
    for (const k of plain.keys) sentPlain[k.key] = { id: 'a', at: k.at };
    expect(dueReminders({ todos: withSetting('before-1h'), now: deadline + 2000, sent: sentPlain })).toEqual([]);
    // an early reminder noticed only after the deadline is announced once as a plain due reminder
    expect(dueReminders({ todos: withSetting('before-1h'), now: deadline + 2000, sent: {} })[0]).toMatchObject({ reminder: 'default' });
  });

  it('never announces a trigger older than seven days', () => {
    const at = '2026-05-01T08:00:00Z';
    const todos = [todo('a', { sourceDeadline: instant(at) })];
    expect(ids(dueReminders({ todos, now: Date.parse(at) + 7 * DAY, sent: {} }))).toEqual(['a']);
    expect(dueReminders({ todos, now: Date.parse(at) + 7 * DAY + 1, sent: {} })).toEqual([]);
  });
});

describe('planReminderToasts', () => {
  it('collapses several missed reminders into one summary but keeps timely ones separate', () => {
    const now = Date.parse('2026-05-02T00:00:00Z');
    const r = (id: string, ago: number) => ({ id, title: id, kind: 'due' as const, reminder: 'default' as const, at: now - ago, keys: [] });
    expect(planReminderToasts([r('a', 3 * DAY)], now)).toMatchObject([{ type: 'single' }]);
    const plan = planReminderToasts([r('a', 3 * DAY), r('b', DAY), r('c', 1000)], now);
    expect(plan.map((p) => p.type)).toEqual(['summary', 'single']);
    expect(plan[0]).toMatchObject({ reminders: [{ id: 'a' }, { id: 'b' }] });
  });
});

describe('reminder runtime', () => {
  it('records reminders as sent while notifications are off, purges personal tombstones daily, keeps state per account', async () => {
    let now = Date.parse('2026-05-01T08:01:00Z');
    let scope: string | null = 'cloud:u1:1';
    let enabled = false;
    const todos = [todo('a', { sourceDeadline: instant('2026-05-01T08:00:00Z') })];
    const store: Record<string, Record<string, { id: string; at: number }>> = {
      'cloud:u1:1': {},
      'cloud:u2:2': {},
    };
    const notify = vi.fn();
    const purge = vi.fn(async () => 0);
    const runtime = createPersonalTodoReminderRuntime({
      scopeKey: () => scope,
      readTodos: async () => todos,
      loadSent: async () => structuredClone(store[scope!]),
      saveSent: async (s) => {
        store[scope!] = structuredClone(s);
      },
      purge,
      notify,
      notificationsEnabled: () => enabled,
      now: () => now,
      setInterval: () => 0,
      clearInterval: () => {},
      subscribeChanges: () => () => {},
    });
    await runtime.evaluate();
    expect(Object.keys(store['cloud:u1:1'])).toHaveLength(1);
    enabled = true;
    await runtime.evaluate();
    expect(notify).not.toHaveBeenCalled(); // no replay once notifications are switched on
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith({ olderThanMs: 30 * DAY, now, keyPrefix: 'personal:' });
    now += DAY;
    await runtime.evaluate();
    expect(purge).toHaveBeenCalledTimes(2);
    scope = 'cloud:u2:2'; // another account has its own sent record
    now = Date.parse('2026-05-01T08:01:00Z');
    await runtime.evaluate();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(Object.keys(store['cloud:u2:2'])).toHaveLength(1);
  });

  // docs/product-rules/personal-todos.md「多台电脑同步」：提醒只在主力电脑触发，副本不弹也不记已发。
  it('stays silent on a replica and announces once the computer becomes the main computer', async () => {
    const now = Date.parse('2026-05-01T08:01:00Z');
    let active = false;
    let saved = 0;
    const notify = vi.fn();
    const purge = vi.fn(async () => 0);
    const runtime = createPersonalTodoReminderRuntime({
      scopeKey: () => 'cloud:u1:1',
      readTodos: async () => [todo('a', { sourceDeadline: instant('2026-05-01T08:00:00Z') })],
      loadSent: async () => ({}),
      saveSent: async () => {
        saved++;
      },
      purge,
      notify,
      notificationsEnabled: () => true,
      remindersActive: async () => active,
      now: () => now,
      setInterval: () => 0,
      clearInterval: () => {},
      subscribeChanges: () => () => {},
    });
    await runtime.evaluate();
    expect(notify).not.toHaveBeenCalled();
    expect(saved).toBe(0);
    expect(purge).not.toHaveBeenCalled();
    active = true;
    await runtime.evaluate();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
