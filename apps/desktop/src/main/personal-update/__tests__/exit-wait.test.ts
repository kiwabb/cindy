import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validatePersonalIdentity, validatePersonalPolicy } from '../contract.mjs';
import { buildPersonalMacTransaction, PERSONAL_CRASHPAD_HANDLER_PATHS } from '../transaction';
import { personalFailureKind, readPersonalFailureMarker, releaseRetryablePersonalFailure } from '../failure';

// Regression (2026-11-25, personal Mac): normal quit finished, but the old bundle's Crashpad handler stayed
// alive, the monitor's wait for an empty bundle timed out, and the revision was marked failed forever while
// the banner said "preparation failed". Preparation had succeeded; only the wait before the exchange failed.

const policy = validatePersonalPolicy({ schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64',
  feedUrl: 'https://github.com/kiwabb/cindy/releases/download/personal-macos-arm64/personal-update.json', storageCompatibilityVersion: 1 });
const identity = validatePersonalIdentity({ schemaVersion: 1, repository: policy.repository, channel: policy.channel,
  revision: 42, sourceCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', region: 'global',
  bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64) }, policy);

const OLD_PID = 123;

function transactionScript(root: string): string {
  const nonce = randomUUID();
  return buildPersonalMacTransaction({
    schemaVersion: 1, nonce, phase: 'prepared', identity, previousIdentity: { ...identity, revision: 41 },
    previousPid: OLD_PID, canonicalApp: '/Applications/Cindy.app', backup: `/Applications/.Cindy-personal-backup-${nonce}.app`,
    health: path.join(root, `health-${nonce}.json`), zip: path.join(root, 'personal-42.zip'), sha256: 'c'.repeat(64),
    helper: path.join(root, `attempt-${nonce}`, 'swap-apps'), helperSha256: 'd'.repeat(64), teamId: 'ABCDEFGHIJ',
    ownerIdentity: 'e'.repeat(64),
  }, root);
}

/** The emitted wait functions, from `bundle_alive` up to (not including) the journal `phase` helper. */
function waitFunctions(script: string): string {
  const begin = script.indexOf('bundle_alive() {');
  const end = script.indexOf('phase() {', begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  return script.slice(begin, end).replaceAll('\r\n', '\n');
}

// macOS runs the real /usr/bin/plutil. Elsewhere a stand-in implements only `-extract <keypath> raw <file>`
// on JSON, failing (like plutil) for a missing key, a null or a collection.
function findBash(): string | null {
  if (process.platform === 'darwin' || process.platform === 'linux') return '/bin/bash';
  const git = 'C:/Program Files/Git/bin/bash.exe';
  return fs.existsSync(git) ? git : null;
}
const bash = findBash();
const slash = (file: string) => file.replaceAll('\\', '/');

interface ProcessRecord { pid: number; ppid?: number; state?: number; zombie: boolean; birth: string; oldIdentityMatches: boolean; executable: string }
const status = (processes: ProcessRecord[], extra: Partial<{ blocked: boolean; unknown: boolean }> = {}) =>
  ({ schemaVersion: 1, processes, blocked: processes.some(p => !p.zombie && p.executable !== '<outside-bundle-or-unavailable>'), unknown: false, ...extra });
const crashpad = (pid = 900, birth = '1700000000:5', executable: string = PERSONAL_CRASHPAD_HANDLER_PATHS[0]): ProcessRecord =>
  ({ pid, ppid: 1, state: 2, zombie: false, birth, oldIdentityMatches: false, executable });
const mainApp: ProcessRecord = { pid: OLD_PID, ppid: 1, state: 2, zombie: false, birth: '1700000000:1', oldIdentityMatches: true, executable: 'Contents/MacOS/Cindy' };
const renderer: ProcessRecord = { pid: 901, ppid: OLD_PID, state: 2, zombie: false, birth: '1700000000:9', oldIdentityMatches: false, executable: 'Contents/Frameworks/Cindy Helper (Renderer).app/Contents/MacOS/Cindy Helper (Renderer)' };

const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** `[keypath]=value` entries for scalar leaves: what `plutil -extract <keypath> raw` prints for them. */
function flatten(value: unknown, prefix = ''): string[] {
  if (value === null) return [];
  if (typeof value !== 'object') return [`[${sh(prefix)}]=${sh(String(value))}`];
  return Object.entries(value as object).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
}

/**
 * Runs the emitted wait functions against an in-shell helper (no process per call, so the loop stays fast
 * on Windows). `--bundle-status` serves `snapshot` (exit `code`) until a signal reaches one of its live
 * PIDs, then an empty bundle. `--pid-birth` reports each record's birth (`births` overrides; '' = gone).
 * `kill` and `sleep` are recorded, never real. macOS parses the snapshot with the real `/usr/bin/plutil`;
 * elsewhere an in-shell stand-in answers `-extract <keypath> raw` for scalar leaves and fails otherwise.
 */
async function runWait(snapshot: object, options: { code?: number; births?: Record<number, string>; seconds?: number; classifyOnly?: boolean; grace?: number; stubborn?: number[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exit-wait-test-'));
  try {
    const births: Record<number, string> = {};
    for (const p of (snapshot as { processes: ProcessRecord[] }).processes) births[p.pid] = p.birth;
    Object.assign(births, options.births);
    const realPlutil = process.platform === 'darwin';
    const birthCases = Object.entries(births).map(([pid, birth]) => `    ${pid}) ${birth ? `printf '%s\n' ${sh(birth)}; return 0` : 'return 1'} ;;`).join('\n');
    // Records the monitor may signal: live handlers at an exact Crashpad path whose start time still matches.
    const livePids = (snapshot as { processes: ProcessRecord[] }).processes
      .filter(p => !p.zombie && (PERSONAL_CRASHPAD_HANDLER_PATHS as readonly string[]).includes(p.executable) && births[p.pid])
      .map(p => String(p.pid));
    const liveCases = livePids.join('|') || 'none';
    const liveCount = Math.max(livePids.length, 1);
    const functions = waitFunctions(transactionScript(root))
      .replace(/^CRASHPAD_GRACE=\d+$/m, `CRASHPAD_GRACE=${options.grace ?? 3}`)
      .replaceAll('/usr/bin/plutil', realPlutil ? '/usr/bin/plutil' : 'fake_plutil')
      .replaceAll('/bin/kill', 'record_kill')
      .replaceAll('/bin/mv', realPlutil ? '/bin/mv' : ':');
    const program = `set -eu
ROOT=${sh(slash(root))}
HELPER=fake_helper
APP=/Applications/Cindy.app
EXIT_STATUS="$ROOT/exit-status.json"
SLEPT=0; KILLED=0; KILLS=""; KILLED_SET=" "; KILLED_COUNT=0
sleep() { SLEPT=$((SLEPT + 1)); }
record_kill() {
  KILLS="$KILLS$1 $2;"
  # The bundle empties only once every live record has been signalled; each signalled PID is gone.
  # A stubborn PID ignores SIGTERM and leaves only on SIGKILL.
  case "$1:$2" in ${(options.stubborn ?? []).map(pid => `-TERM:${pid}`).join('|') || 'none'}) return 0 ;; esac
  case "$2" in ${liveCases}) case "$KILLED_SET" in *" $2 "*) ;; *) KILLED_SET="$KILLED_SET$2 "; KILLED_COUNT=$((KILLED_COUNT + 1)) ;; esac ;; esac
  if [ "$KILLED_COUNT" -ge ${liveCount} ]; then KILLED=1; fi
}
fake_helper() {
  if [ "$1" = --bundle-status ]; then
    if [ "$KILLED" = 1 ]; then printf '%s\n' ${sh(JSON.stringify(status([])))}; return 0; fi
    printf '%s\n' ${sh(JSON.stringify(snapshot))}; return ${options.code ?? 75}
  fi
  [ "$1" = --pid-birth ] && [ "$KILLED" = 0 ] || return 1
  case "$KILLED_SET" in *" $2 "*) return 1 ;; esac
  case "$2" in
${birthCases}
  esac
  return 1
}
${realPlutil ? '' : `declare -A SNAPSHOT=(${flatten(snapshot).join(' ')})
declare -A EMPTY=(${flatten(status([])).join(' ')})
fake_plutil() {
  [ "$1" = -extract ] && [ "$3" = raw ] && [ "$4" = "$EXIT_STATUS" ] || return 2
  if [ "$KILLED" = 1 ]; then [[ -v EMPTY[$2] ]] || return 1; printf '%s\n' "\${EMPTY[$2]}"
  else [[ -v SNAPSHOT[$2] ]] || return 1; printf '%s\n' "\${SNAPSHOT[$2]}"; fi
}`}
${functions}
${options.classifyOnly
    // One snapshot and the decision alone: whether this state may ever lead to a signal.
    ? 'if bundle_alive && only_stale_crashpad_left; then RESULT=eligible; else RESULT=wait; fi'
    : `if wait_old_bundle ${options.seconds ?? 30}; then RESULT=exchange; else RESULT=timeout; fi`}
printf '%s %s %s %s %s\n' "$RESULT" "$SLEPT" "$LAST_WAIT_CRASHPAD_ONLY" "$CRASHPAD_STOPPED" "$KILLS"
`;
    // Asynchronous so a long emulated wait never blocks the test worker.
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      const child = execFile(bash!, ['-s'], { encoding: 'utf8' }, (error, stdout, stderr) =>
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
      child.stdin!.end(program);
    });
    expect(result.status, result.stderr).toBe(0);
    const [outcome, slept, lastCrashpadOnly, stopped, ...rest] = result.stdout.trim().split(' ');
    const kills = rest.join(' ').split(';').filter(Boolean);
    const stopRecord = path.join(root, 'crashpad-stop.json');
    return { outcome, slept: Number(slept), lastCrashpadOnly: lastCrashpadOnly === '1', stopped: Number(stopped), kills,
      stopRecord: fs.existsSync(stopRecord) ? JSON.parse(fs.readFileSync(stopRecord, 'utf8')) : null };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe.skipIf(!bash)('personal update wait for the old bundle to exit', () => {
  it('stops a lone old-bundle Crashpad handler after the grace period, then exchanges', async () => {
    const result = await runWait(status([crashpad()]));
    expect(result.outcome).toBe('exchange');
    expect(result.kills).toEqual(['-TERM 900']);
    expect(result.slept).toBeGreaterThanOrEqual(3);
    expect(result.stopRecord).toMatchObject({ stopRounds: 1, signals: " -TERM:900" });
  });

  it('accepts the unversioned Helpers path and an already-exited (zombie) old main process', async () => {
    const zombieMain = { ...mainApp, zombie: true, state: 5 };
    const result = await runWait(status([zombieMain, crashpad(900, '1700000000:5', PERSONAL_CRASHPAD_HANDLER_PATHS[1])]));
    expect(result.outcome).toBe('exchange');
    expect(result.kills).toEqual(['-TERM 900']);
  });

  it('accepts the old PID number already reused by an unrelated outside-bundle process', async () => {
    const reused = { pid: OLD_PID, ppid: 1, state: 2, zombie: false, birth: '1800000000:1', oldIdentityMatches: false, executable: '<outside-bundle-or-unavailable>' };
    const result = await runWait(status([reused, crashpad()]));
    expect(result.outcome).toBe('exchange');
    expect(result.kills).toEqual(['-TERM 900']);
  });

  // 2026-11-26 (Mac sample): a handler left by an earlier run survives the next launch, so the next exchange can
  // find two handlers: one under the unversioned `Helpers` path and one under `Versions/A`.
  it('stops every lone old-bundle Crashpad handler, under either path form, before exchanging', async () => {
    const result = await runWait(status([
      crashpad(31444, '1764121000:1', PERSONAL_CRASHPAD_HANDLER_PATHS[1]),
      crashpad(189, '1764121400:2', PERSONAL_CRASHPAD_HANDLER_PATHS[0]),
    ]));
    expect(result.outcome).toBe('exchange');
    expect(result.kills).toEqual(['-TERM 31444', '-TERM 189']);
    expect(result.stopRecord).toMatchObject({ stopRounds: 1, signals: ' -TERM:31444 -TERM:189' });
  });

  it('escalates only the handler that ignores SIGTERM among several', async () => {
    // 189 is reported alive again after SIGTERM (same start time), so it alone receives SIGKILL.
    const result = await runWait(status([
      crashpad(31444, '1764121000:1', PERSONAL_CRASHPAD_HANDLER_PATHS[1]),
      crashpad(189, '1764121400:2', PERSONAL_CRASHPAD_HANDLER_PATHS[0]),
    ]), { stubborn: [189] });
    expect(result.outcome).toBe('exchange');
    expect(result.kills).toEqual(['-TERM 31444', '-TERM 189', '-KILL 189']);
  });

  it('keeps waiting without signals when two handlers remain beside the old main process', async () => {
    const snapshot = status([mainApp, crashpad(31444, '1764121000:1', PERSONAL_CRASHPAD_HANDLER_PATHS[1]), crashpad(189, '1764121400:2')]);
    expect((await runWait(snapshot, { classifyOnly: true })).outcome).toBe('wait');
  });

  it.each([
    ['the old main process is still alive', status([mainApp, crashpad()])],
    ['only the old main process is alive', status([mainApp])],
    ['another bundle process (a renderer) is still alive', status([renderer, crashpad()])],
    ['a same-named handler runs from another path in the bundle', status([crashpad(902, '1700000000:7', 'Contents/Resources/chrome_crashpad_handler')])],
    ['the old PID still matches its identity outside the bundle', status([{ ...mainApp, executable: '<outside-bundle-or-unavailable>' }, crashpad()])],
    ['the helper reports unknown process state', status([crashpad()], { unknown: true })],
    ['the snapshot is truncated at the 64-record limit', status(Array.from({ length: 64 }, (_, i) => crashpad(1000 + i, `1700000000:${i}`)))],
  ])('never treats the bundle as Crashpad-only while %s', async (_label, snapshot) => {
    expect((await runWait(snapshot, { classifyOnly: true })).outcome).toBe('wait');
  });

  it('keeps the plain wait, without signals, when the old main process stays alive', async () => {
    const result = await runWait(status([mainApp, crashpad()]), { seconds: 6 });
    expect(result.outcome).toBe('timeout');
    expect(result.kills).toEqual([]);
    expect(result.lastCrashpadOnly).toBe(false);
  });

  it('does not treat a failed status call (exit 2) as Crashpad-only', async () => {
    expect((await runWait(status([crashpad()]), { code: 2, classifyOnly: true })).outcome).toBe('wait');
  });

  it('does not signal a PID whose start time no longer matches the snapshot (PID reused)', async () => {
    const result = await runWait(status([crashpad()]), { births: { 900: '1800000000:1' }, seconds: 8 });
    expect(result.outcome).toBe('timeout');
    expect(result.kills).toEqual([]);
    // Both bounded rounds found no matching process: nothing is recorded as stopped, and the failure names the lone-handler case.
    expect(result.stopped).toBe(0);
    expect(result.stopRecord).toBeNull();
    expect(result.lastCrashpadOnly).toBe(true);
  });

  it('records the lone-handler timeout reason in the emitted failure path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exit-wait-script-'));
    try {
      const script = transactionScript(root);
      expect(script).toContain('FAILURE_REASON=stale_crashpad_not_stopped');
      // The re-check before the exchange is unchanged: the bundle must still be empty afterwards.
      expect(script).toContain('if bundle_alive; then FAILURE_REASON=bundle_reappeared_before_swap; exit 1; fi');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// 2026-11-26: every pre-exchange failure left a full unswapped app copy in /Applications
// (`.Cindy-personal-backup-<nonce>.app`) plus its extraction, and only committed receipts were ever pruned.
describe.skipIf(!bash)('personal update rollback removes only its own unswapped copy', () => {
  interface Case { failedFrom: string; appIs?: number; backupIs?: number | 'partial'; backupLink?: boolean }

  /**
   * Runs the emitted `discard_unswapped_copy` with real directories and `/bin/rm`. Only the code-signature
   * check (`matches`) is replaced: it reports a directory as the revision written in its `revision` file.
   */
  async function runDiscard(c: Case) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-discard-test-')));
    try {
      const script = transactionScript(root).replaceAll('\r\n', '\n');
      const begin = script.indexOf('discard_unswapped_copy() {');
      const end = script.indexOf('rollback() {', begin);
      expect(begin).toBeGreaterThan(0);
      const app = path.join(root, 'Applications', 'Cindy.app');
      const backup = path.join(root, 'Applications', '.Cindy-personal-backup-test.app');
      const extract = path.join(root, 'extract-test');
      const attempt = path.join(root, 'attempt-test');
      const outside = path.join(root, 'elsewhere.app');
      for (const dir of [app, extract, attempt, outside]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(app, 'revision'), String(c.appIs ?? 41));
      fs.writeFileSync(path.join(extract, 'payload'), 'x');
      fs.writeFileSync(path.join(outside, 'revision'), '42');
      if (c.backupLink) fs.symlinkSync(outside, backup, process.platform === 'win32' ? 'junction' : 'dir');
      else {
        fs.mkdirSync(backup);
        if (c.backupIs !== 'partial') fs.writeFileSync(path.join(backup, 'revision'), String(c.backupIs ?? 42));
      }
      const program = `set -eu
APP=${sh(slash(app))}
BACKUP=${sh(slash(backup))}
EXTRACT=${sh(slash(extract))}
EXIT_STATUS=${sh(slash(path.join(attempt, 'exit-status.json')))}
FAILED_FROM=${sh(c.failedFrom)}
matches() { [ -f "$1/revision" ] && [ "$(cat "$1/revision")" = "$2" ]; }
${script.slice(begin, end)}
discard_unswapped_copy || true
`;
      const result = await new Promise<{ code: number; stderr: string }>(resolve => {
        const child = execFile(bash!, ['-s'], { encoding: 'utf8' }, (error, _stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stderr }));
        child.stdin!.end(program);
      });
      expect(result.code, result.stderr).toBe(0);
      return {
        backup: fs.existsSync(backup), extract: fs.existsSync(extract), app: fs.existsSync(path.join(app, 'revision')),
        linkTarget: fs.existsSync(path.join(outside, 'revision')),
        recorded: fs.existsSync(path.join(attempt, 'unswapped-copy-removed.json')),
      };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  it.each(['waiting-for-exit', 'prepared'])('removes the verified unswapped copy and extraction after a failure in %s', async failedFrom => {
    expect(await runDiscard({ failedFrom })).toEqual({ backup: false, extract: false, app: true, linkTarget: true, recorded: true });
  });

  it.each([
    ['the journal reached the exchange', { failedFrom: 'swapping' }],
    ['the new app was waiting for its health receipt', { failedFrom: 'awaiting-health' }],
    ['the failed phase is unknown', { failedFrom: '' }],
    ['the canonical app is not the previous revision', { failedFrom: 'waiting-for-exit', appIs: 42 }],
    ['the copy does not verify as this target', { failedFrom: 'waiting-for-exit', backupIs: 43 }],
    ['the copy is partial', { failedFrom: 'prepared', backupIs: 'partial' as const }],
  ])('keeps everything when %s', async (_label, c) => {
    expect(await runDiscard(c)).toEqual({ backup: true, extract: true, app: true, linkTarget: true, recorded: false });
  });

  it('never follows a link placed at the backup path', async () => {
    const result = await runDiscard({ failedFrom: 'waiting-for-exit', backupLink: true });
    expect(result).toMatchObject({ backup: true, extract: true, linkTarget: true, recorded: false });
  });

  it('runs the cleanup after the failure marker is written and before the lock is released', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-discard-order-'));
    try {
      const script = transactionScript(root);
      const body = script.slice(script.indexOf('rollback() {'));
      const marker = body.indexOf('/bin/cp "$JOURNAL"'), discard = body.indexOf('discard_unswapped_copy || true'), unlock = body.indexOf('/bin/rm -rf "$LOCK"');
      expect(marker).toBeGreaterThan(0);
      expect(discard).toBeGreaterThan(marker);
      expect(unlock).toBeGreaterThan(discard);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('personal update failure marker after the macOS monitor rolls back', () => {
  const journalCopy = (failureReason: string | undefined, failedFromPhase: string) =>
    ({ schemaVersion: 1, phase: 'failed', failedFromPhase, ...(failureReason ? { failureReason } : {}), identity: { revision: 42 } });
  const withMarker = <T>(value: unknown, run: (root: string) => T): T => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-failure-marker-test-'));
    try {
      fs.writeFileSync(path.join(root, 'failed-42.json'), typeof value === 'string' ? value : JSON.stringify(value));
      return run(root);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };

  it.each([
    ['old_bundle_exit_timeout', 'waiting-for-exit', 'PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT', 'exit'],
    ['stale_crashpad_not_stopped', 'waiting-for-exit', 'PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT', 'exit'],
    ['bundle_reappeared_before_swap', 'waiting-for-exit', 'PERSONAL_UPDATE_OLD_APP_REAPPEARED', 'exit'],
    ['bundle_status_unavailable', 'waiting-for-exit', 'PERSONAL_UPDATE_EXIT_STATUS_UNAVAILABLE', 'install'],
    ['transaction_command_failed', 'awaiting-health', 'PERSONAL_UPDATE_NEW_APP_HEALTH_FAILED', 'install'],
    ['transaction_command_failed', 'swapping', 'PERSONAL_UPDATE_APPLY_FAILED', 'install'],
    [undefined, 'prepared', 'PERSONAL_UPDATE_APPLY_FAILED', 'install'],
    ['some_future_reason', 'not-a-phase', 'PERSONAL_UPDATE_APPLY_FAILED', 'install'],
  ] as const)('maps monitor reason %s from %s to %s', (failureReason, phase, code, kind) => {
    const marker = withMarker(journalCopy(failureReason, phase), root => readPersonalFailureMarker(root, 42));
    expect(marker?.reason).toBe(code);
    expect(personalFailureKind(marker!.reason)).toBe(kind);
    expect(marker?.failedFromPhase).toBe(phase === 'not-a-phase' ? undefined : phase);
  });

  it('keeps preparation failures on the preparation wording', () => {
    expect(withMarker({ revision: 42, phase: 'preparation-failed', reason: 'PERSONAL_UPDATE_RESIGN_FAILED' },
      root => personalFailureKind(readPersonalFailureMarker(root, 42)!.reason))).toBe('failed');
    expect(withMarker({ revision: 42, phase: 'preparation-failed' }, root => readPersonalFailureMarker(root, 42)?.reason))
      .toBe('PERSONAL_UPDATE_PREPARATION_FAILED');
    expect(withMarker('not json', root => readPersonalFailureMarker(root, 42)?.reason)).toBe('PERSONAL_UPDATE_PREPARATION_FAILED');
  });

  it('releases an exit-wait failure for exactly one more automatic attempt, keeping the evidence', () => {
    withMarker(journalCopy('old_bundle_exit_timeout', 'waiting-for-exit'), root => {
      // An unrelated revision whose number shares the prefix must not count as a retry of 42.
      fs.writeFileSync(path.join(root, 'exit-retry-420-1.json'), '{}');
      expect(releaseRetryablePersonalFailure(root, 42)).toBe(true);
      expect(readPersonalFailureMarker(root, 42)).toBeNull();
      expect(JSON.parse(fs.readFileSync(path.join(root, 'exit-retry-42-1.json'), 'utf8')).failureReason).toBe('old_bundle_exit_timeout');
      // The retry fails the same way: the revision is now skipped and shown with the exit wording.
      fs.writeFileSync(path.join(root, 'failed-42.json'), JSON.stringify(journalCopy('stale_crashpad_not_stopped', 'waiting-for-exit')));
      expect(releaseRetryablePersonalFailure(root, 42)).toBe(false);
      expect(readPersonalFailureMarker(root, 42)?.reason).toBe('PERSONAL_UPDATE_OLD_APP_EXIT_TIMEOUT');
    });
  });

  it.each([
    ['a preparation failure', { revision: 42, phase: 'preparation-failed', reason: 'PERSONAL_UPDATE_RESIGN_FAILED' }],
    ['a signing preflight failure', { revision: 42, phase: 'preflight-failed', reason: 'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE' }],
    ['a failed new-app health check', journalCopy('transaction_command_failed', 'awaiting-health')],
    ['an unavailable process status', journalCopy('bundle_status_unavailable', 'waiting-for-exit')],
    ['a Windows apply failure', { revision: 42, phase: 'windows-apply-failed' }],
  ])('never releases %s', (_label, value) => {
    withMarker(value, root => {
      expect(releaseRetryablePersonalFailure(root, 42)).toBe(false);
      expect(fs.existsSync(path.join(root, 'failed-42.json'))).toBe(true);
    });
  });

  it('does nothing without a marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-failure-marker-empty-'));
    try { expect(releaseRetryablePersonalFailure(root, 42)).toBe(false); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
