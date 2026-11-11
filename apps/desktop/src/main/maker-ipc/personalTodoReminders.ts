import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Notification, powerMonitor } from 'electron';
import { effectiveTodoDeadline, type TeammateTodo, type TodoDeadline } from '@cindy/maker-shared/teammate-todo';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { openMainWindowTodos } from '../deepLink.js';
import { t } from '../i18n.desktop.js';
import { createLogger } from '../logger.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import { createBotTodoStore } from './botTodoStore.js';
import { onPersonalTodosChanged, openPersonalTodoStore, PERSONAL_TODO_FILE } from './personalTodoAccess.js';

const log = createLogger('personalTodoReminders');

export const REMINDER_STATE_FILE = 'personal-todo-reminders.v1.json';
const TICK_MS = 60_000;
const DATE_REMINDER_HOUR = 9;
/** A trigger older than this is never announced; the todo board still shows it. */
export const MAX_REMINDER_AGE_MS = 7 * 86_400_000;
/** Older than one tick plus slack means the app was closed or asleep when it came due. */
export const MISSED_AFTER_MS = 5 * 60_000;
const SENT_RETENTION_MS = 14 * 86_400_000;
const PURGE_INTERVAL_MS = 86_400_000;
const PURGE_OLDER_THAN_MS = 30 * 86_400_000;
const PERSONAL_KEY_PREFIX = 'personal:';

export type ReminderKind = 'due' | 'resumed';
export interface DueReminder {
  id: string;
  title: string;
  kind: ReminderKind;
  /** When the strongest trigger came due (epoch ms). */
  at: number;
  /** Fingerprints of every trigger this reminder covers, to be recorded once announced. */
  keys: Array<{ key: string; at: number }>;
}
/** Announced fingerprints: key -> { id, at } so they can be pruned with their item. */
export type SentReminders = Record<string, { id: string; at: number }>;

function zoneOffsetMs(utc: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utc));
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(utc / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads `date` + `hour`:00 (DST-safe, two-pass). */
export function zonedWallTimeToUtc(date: string, hour: number, timeZone: string): number {
  const nominal = Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000;
  let utc = nominal - zoneOffsetMs(nominal, timeZone);
  utc = nominal - zoneOffsetMs(utc, timeZone);
  return utc;
}

function deadlineInstant(d: TodoDeadline): number {
  return d.kind === 'instant' ? Date.parse(d.at!) : zonedWallTimeToUtc(d.date, DATE_REMINDER_HOUR, d.timeZone);
}

/**
 * Which todos are due for an announcement now. Pure: no clock, no I/O.
 * Open, not deleted/muted, not currently deferred. A trigger is the deadline moment (instants at
 * `at`, dates at 09:00 in the deadline's zone) or the end of a deferral. Its fingerprint is the
 * trigger moment, so editing the deadline re-arms while a re-read never repeats.
 */
export function dueReminders(params: {
  todos: readonly TeammateTodo[];
  now: number;
  sent: SentReminders;
}): DueReminder[] {
  const { todos, now, sent } = params;
  const out: DueReminder[] = [];
  for (const todo of todos) {
    if (todo.status !== 'open') continue;
    const decision = todo.decision;
    if (decision && decision.kind !== 'later') continue;
    const until = decision?.until ? Date.parse(decision.until) : NaN;
    if (decision && !(until <= now)) continue; // still deferred
    const triggers: Array<{ kind: ReminderKind; at: number }> = [];
    const deadline = effectiveTodoDeadline(todo);
    if (deadline) triggers.push({ kind: 'due', at: deadlineInstant(deadline) });
    if (decision) triggers.push({ kind: 'resumed', at: until });
    const fresh = triggers.filter(
      (tr) => Number.isFinite(tr.at) && tr.at <= now && now - tr.at <= MAX_REMINDER_AGE_MS,
    );
    const added = fresh
      .map((tr) => ({ ...tr, key: `${todo.id}|${tr.kind}|${tr.at}` }))
      .filter((tr) => !sent[tr.key]);
    if (!added.length) continue;
    const lead = added.find((tr) => tr.kind === 'due') ?? added[0];
    const keys = added.map((tr) => ({ key: tr.key, at: tr.at }));
    out.push({ id: todo.id, title: todo.title, kind: lead.kind, at: lead.at, keys });
  }
  return out.sort((a, b) => a.at - b.at);
}

export type ReminderToast =
  | { type: 'single'; reminder: DueReminder }
  | { type: 'summary'; reminders: DueReminder[] };

/** On time reminders go out one by one; several missed ones (closed/asleep) collapse into one toast. */
export function planReminderToasts(reminders: readonly DueReminder[], now: number): ReminderToast[] {
  const timely = reminders.filter((r) => now - r.at <= MISSED_AFTER_MS);
  const missed = reminders.filter((r) => now - r.at > MISSED_AFTER_MS);
  const toasts: ReminderToast[] = missed.length > 1
    ? [{ type: 'summary', reminders: missed }]
    : missed.map((reminder) => ({ type: 'single' as const, reminder }));
  return [...toasts, ...timely.map((reminder) => ({ type: 'single' as const, reminder }))];
}

export interface ReminderRuntimeDeps {
  /** null while nobody is signed in or an account switch is in flight. */
  scopeKey(): string | null;
  readTodos(): Promise<TeammateTodo[]>;
  loadSent(): Promise<SentReminders>;
  saveSent(sent: SentReminders): Promise<void>;
  purge(params: { olderThanMs: number; now: number; keyPrefix: string }): Promise<number>;
  notify(toast: ReminderToast): void;
  notificationsEnabled(): boolean;
  now(): number;
  setInterval(fn: () => void, ms: number): { unref?: () => void } | number;
  clearInterval(handle: { unref?: () => void } | number): void;
  subscribeChanges(listener: () => void): () => void;
}

export function createPersonalTodoReminderRuntime(deps: ReminderRuntimeDeps) {
  let scope: string | null = null;
  let sent: SentReminders = {};
  let lastPurge = 0;
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<ReminderRuntimeDeps['setInterval']> | undefined;
  let unsubscribe: (() => void) | undefined;

  async function pass(): Promise<void> {
    const current = deps.scopeKey();
    if (!current) return;
    if (current !== scope) {
      sent = await deps.loadSent();
      scope = current;
      lastPurge = 0;
    }
    const now = deps.now();
    if (now - lastPurge >= PURGE_INTERVAL_MS) {
      lastPurge = now;
      const purged = await deps
        .purge({ olderThanMs: PURGE_OLDER_THAN_MS, now, keyPrefix: PERSONAL_KEY_PREFIX })
        .catch((error) => {
          log.warn('tombstone purge failed', { error: String(error) });
          return 0;
        });
      if (purged) log.info('purged deleted personal todos', { count: purged });
    }
    const todos = await deps.readTodos();
    if (deps.scopeKey() !== current) return;
    const due = dueReminders({ todos, now, sent });
    const ids = new Set(todos.map((x) => x.id));
    let changed = false;
    for (const [key, entry] of Object.entries(sent)) {
      if (!ids.has(entry.id) || entry.at < now - SENT_RETENTION_MS) {
        delete sent[key];
        changed = true;
      }
    }
    for (const reminder of due) for (const k of reminder.keys) sent[k.key] = { id: reminder.id, at: k.at };
    if (!changed && !due.length) return;
    // Recorded before announcing: a crash in between loses one toast instead of repeating it.
    await deps.saveSent(sent);
    if (deps.scopeKey() !== current || !due.length || !deps.notificationsEnabled()) return;
    for (const toast of planReminderToasts(due, now)) deps.notify(toast);
  }

  function evaluate(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (error) {
          // Owner changes mid-pass are expected; the next tick starts over for the new account.
          log.debug('reminder pass skipped', { error: String(error) });
        }
      } while (again);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    evaluate,
    start() {
      if (timer !== undefined) return;
      timer = deps.setInterval(() => void evaluate(), TICK_MS);
      if (typeof timer === 'object') timer.unref?.();
      unsubscribe = deps.subscribeChanges(() => void evaluate());
      void evaluate();
    },
    stop() {
      if (timer !== undefined) deps.clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

// ---- Electron wiring -------------------------------------------------------------------------

const liveNotifications = new Set<Notification>();

function show(toast: ReminderToast): void {
  if (!Notification.isSupported()) return;
  const label = (r: DueReminder) =>
    t(r.kind === 'resumed' ? 'personalTodos.reminder.resumed' : 'personalTodos.reminder.due');
  const content =
    toast.type === 'single'
      ? { title: toast.reminder.title, body: label(toast.reminder) }
      : {
          title: t('personalTodos.reminder.summary').replaceAll('{{count}}', String(toast.reminders.length)),
          body: toast.reminders.slice(0, 3).map((r) => r.title).join(' / ') + (toast.reminders.length > 3 ? ' …' : ''),
        };
  const notification = new Notification(content);
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    release();
    openMainWindowTodos();
  });
  notification.on('close', release);
  notification.on('failed', release);
  notification.show();
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export function startPersonalTodoReminders() {
  // The account file pinned to the current owner; reads and purges fail once the account moves.
  const botStore = () => {
    const { assertCurrent } = openPersonalTodoStore();
    return createBotTodoStore(path.join(ownerScopedUserDataPath(), PERSONAL_TODO_FILE), assertCurrent);
  };
  const stateFile = () => path.join(ownerScopedUserDataPath(), REMINDER_STATE_FILE);
  const runtime = createPersonalTodoReminderRuntime({
    scopeKey: () => (isAppSessionBoundaryPending() || !getActiveAppSession().dataOwnerId ? null : activeOwnerScopeKey()),
    readTodos: async () => (await botStore().read()).items,
    loadSent: async () => {
      try {
        const raw = JSON.parse(await fs.readFile(stateFile(), 'utf8')) as { version?: number; sent?: SentReminders };
        return raw?.version === 1 && raw.sent && typeof raw.sent === 'object' ? raw.sent : {};
      } catch {
        return {};
      }
    },
    saveSent: (sent) => atomicWrite(stateFile(), JSON.stringify({ version: 1, sent }) + '\n'),
    purge: (params) => botStore().purgeDeleted(params),
    notify: show,
    notificationsEnabled: getDesktopNotificationsEnabled,
    now: Date.now,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    subscribeChanges: onPersonalTodosChanged,
  });
  const onResume = () => void runtime.evaluate();
  powerMonitor.on('resume', onResume);
  runtime.start();
  return {
    evaluate: runtime.evaluate,
    stop() {
      powerMonitor.removeListener('resume', onResume);
      runtime.stop();
    },
  };
}
