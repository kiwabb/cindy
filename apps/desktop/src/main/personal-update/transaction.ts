import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { validatePersonalIdentity, resolvePersonalPolicy, type PersonalIdentity, type PersonalPolicy } from './contract.mjs';
import policyValue from '../../../personal-update-channel.json';
import { fileSha256 } from './prepareProcess.js';
import { appleDevelopmentRequirement, readLocalSigningIdentifier, verifyAppleDevelopmentSignature } from './signing-core.mjs';

export interface PersonalJournal {
  previousProcessBirth?: string;
  schemaVersion: 1; nonce: string; phase: string; identity: PersonalIdentity;
  canonicalApp: string; backup: string; health: string; previousPid: number; zip: string; sha256: string; previousIdentity: PersonalIdentity; helper: string; helperSha256: string; teamId: string; ownerIdentity: string;
}

export function writeAtomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  // Windows cannot open a directory for fsync; the file itself was already flushed and renamed atomically.
  if (process.platform === 'win32') return;
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Exact executable paths, relative to the canonical bundle, of the Electron Crashpad handler. `proc_pidpath`
 * reports the resolved vnode path; the unversioned form covers a launch through the `Helpers` symlink.
 * A same-named handler of any other application is outside the bundle and never matches.
 */
export const PERSONAL_CRASHPAD_HANDLER_PATHS = [
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
  'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
] as const;

/** Consecutive seconds only the old bundle's Crashpad handler must remain before the monitor stops it. */
export const CRASHPAD_GRACE_SECONDS = 10;

/**
 * The old app's Crashpad handler is spawned detached (double fork, reparented to PID 1) and exits only when
 * every send right to its exception port is gone. Processes the app starts inherit that right, so an
 * outside-bundle descendant that outlives the app can keep the handler, and therefore the bundle, alive.
 *
 * `only_stale_crashpad_left` accepts the helper's latest snapshot only when it is complete (`--bundle-status`
 * exit 75, nothing unknown, fewer than 64 records) and every live record is either an exact in-bundle
 * Crashpad handler path, or the old PID number already reused by an unrelated outside-bundle process.
 * The old main process, any other bundle process, unknown state or a parse failure keeps the plain wait.
 * `stop_stale_crashpad` signals only a PID whose kernel start time still equals the snapshot: SIGTERM, then
 * SIGKILL after five seconds. The exchange still requires a later snapshot with an empty bundle.
 */
function staleCrashpadFunctions(previousPid: number): string[] {
  const q = quote;
  return [
    `OLD_PID=${previousPid}`,
    `CRASHPAD_GRACE=${CRASHPAD_GRACE_SECONDS}`,
    `CRASHPAD_PATH_A=${q(PERSONAL_CRASHPAD_HANDLER_PATHS[0])}`,
    `CRASHPAD_PATH_B=${q(PERSONAL_CRASHPAD_HANDLER_PATHS[1])}`,
    'CRASHPAD_STOP_RECORD="${EXIT_STATUS%/*}/crashpad-stop.json"',
    'STALE_CRASHPAD=""', 'SIGNALLED=""', 'CRASHPAD_STOP_ROUNDS=0', 'CRASHPAD_STOPPED=0', 'LAST_WAIT_CRASHPAD_ONLY=0',
    'status_field() { /usr/bin/plutil -extract "$1" raw "$EXIT_STATUS" 2>/dev/null; }',
    'only_stale_crashpad_left() {',
    '  STALE_CRASHPAD=""',
    '  [ "${BUNDLE_STATUS:-}" = 75 ] || return 1',
    '  [ "$(status_field unknown)" = false ] || return 1',
    '  [ "$(status_field blocked)" = true ] || return 1',
    '  # The helper records at most 64 processes; a 64th record means the list may be incomplete.',
    '  if status_field processes.63.pid >/dev/null; then return 1; fi',
    '  N=0',
    '  while P_PID=$(status_field "processes.$N.pid"); do',
    '    [ "$N" -lt 63 ] || return 1',
    '    case "$P_PID" in ""|*[!0-9]*) return 1 ;; esac',
    '    P_ZOMBIE=$(status_field "processes.$N.zombie") || return 1',
    '    P_EXE=$(status_field "processes.$N.executable") || return 1',
    '    P_BIRTH=$(status_field "processes.$N.birth") || return 1',
    '    case "$P_BIRTH" in ""|*[!0-9:]*) return 1 ;; esac',
    '    if [ "$P_ZOMBIE" = true ]; then :',
    '    elif [ "$P_ZOMBIE" != false ]; then return 1',
    '    elif [ "$P_PID" != "$OLD_PID" ] && { [ "$P_EXE" = "$CRASHPAD_PATH_A" ] || [ "$P_EXE" = "$CRASHPAD_PATH_B" ]; }; then',
    '      STALE_CRASHPAD="$STALE_CRASHPAD $P_PID=$P_BIRTH"',
    '    elif [ "$P_PID" = "$OLD_PID" ] && [ "$P_EXE" = "<outside-bundle-or-unavailable>" ] \\',
    '      && [ "$(status_field "processes.$N.oldIdentityMatches")" = false ]; then :',
    '    else return 1',
    '    fi',
    '    N=$((N + 1))',
    '  done',
    '  [ -n "$STALE_CRASHPAD" ]',
    '}',
    'same_process() { [ "$("$HELPER" --pid-birth "$1" 2>/dev/null)" = "$2" ]; }',
    'signal_stale_crashpad() {',
    '  for ENTRY in $STALE_CRASHPAD; do',
    '    if same_process "${ENTRY%%=*}" "${ENTRY#*=}"; then /bin/kill "$1" "${ENTRY%%=*}" 2>/dev/null || true; SIGNALLED="$SIGNALLED $1:${ENTRY%%=*}"; fi',
    '  done',
    '}',
    'stale_crashpad_alive() {',
    '  for ENTRY in $STALE_CRASHPAD; do',
    '    if same_process "${ENTRY%%=*}" "${ENTRY#*=}"; then return 0; fi',
    '  done',
    '  return 1',
    '}',
    'stop_stale_crashpad() {',
    '  CRASHPAD_STOP_ROUNDS=$((CRASHPAD_STOP_ROUNDS + 1))', '  SIGNALLED=""',
    '  signal_stale_crashpad -TERM',
    '  for j in 1 2 3 4 5; do',
    '    if ! stale_crashpad_alive; then break; fi',
    '    sleep 1',
    '  done',
    '  if stale_crashpad_alive; then signal_stale_crashpad -KILL; sleep 1; fi',
    '  # Record only a round that actually signalled a matching process.',
    '  [ -n "$SIGNALLED" ] || return 0',
    '  CRASHPAD_STOPPED=$((CRASHPAD_STOPPED + 1))',
    `  printf '{"stopRounds":%s,"signals":"%s"}\\n' "$CRASHPAD_STOPPED" "$SIGNALLED" > "$CRASHPAD_STOP_RECORD" || true`,
    '}',
  ];
}

/** Only the new canonical app may acknowledge this nonce after its real owner DB opens. */
export function acknowledgePersonalStorageReady(root: string, canonicalApp: string, identity: PersonalIdentity, ownerIdentity: string, processBirth: string, pid = process.pid): boolean {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'transaction.json'), 'utf8')) as PersonalJournal;
    if (journal.schemaVersion !== 1 || !['prepared', 'waiting-for-exit', 'swapping', 'awaiting-health'].includes(journal.phase) || journal.canonicalApp !== canonicalApp
      || journal.identity.revision !== identity.revision || journal.identity.sourceCommit !== identity.sourceCommit
      || journal.identity.storageIdentity !== identity.storageIdentity || !/^[a-f0-9-]{36}$/.test(journal.nonce)
      || journal.health !== path.join(root, `health-${journal.nonce}.json`)
      || journal.ownerIdentity !== ownerIdentity || !/^[a-f0-9]{64}$/.test(ownerIdentity)
      || !/^\d+:\d+$/.test(processBirth)) return false;
    writeAtomicJson(journal.health, { nonce: journal.nonce, revision: identity.revision,
      storageIdentity: identity.storageIdentity, canonicalApp, pid, storageOpened: true, coreReady: true, ownerIdentity, processBirth });
    return true;
  } catch { return false; }
}

export function buildPersonalMacTransaction(journal: PersonalJournal, root: string): string {
  const policy = resolvePersonalPolicy(policyValue, 'darwin', 'arm64') as PersonalPolicy;
  validatePersonalIdentity(journal.identity, policy);
  validatePersonalIdentity(journal.previousIdentity, policy);
  if (journal.identity.revision <= journal.previousIdentity.revision
    || journal.identity.storageIdentity !== journal.previousIdentity.storageIdentity) throw new Error('Invalid personal transaction identity');
  if (journal.canonicalApp !== '/Applications/Cindy.app' || !Number.isSafeInteger(journal.previousPid)
    || journal.previousPid <= 0 || !/^[a-f0-9]{64}$/.test(journal.sha256)
    || !/^[a-f0-9]{64}$/.test(journal.helperSha256) || !/^[a-f0-9-]{36}$/.test(journal.nonce)
    || journal.backup !== `/Applications/.Cindy-personal-backup-${journal.nonce}.app`
    || journal.helper !== path.join(root, `attempt-${journal.nonce}`, 'swap-apps')
    || journal.health !== path.join(root, `health-${journal.nonce}.json`)
    || !/^[a-f0-9]{64}$/.test(journal.ownerIdentity)
    || !['prepared', 'waiting-for-exit', 'swapping', 'awaiting-health', 'committed', 'failed'].includes(journal.phase)
    || (journal.previousProcessBirth !== undefined && !/^\d+:\d+$/.test(journal.previousProcessBirth))
    || journal.zip !== path.join(root, `personal-${journal.identity.revision}.zip`)) throw new Error('Invalid personal transaction');
  const q = quote, record = path.join(root, 'transaction.json');
  const lock = path.join(root, `attempt-${journal.nonce}`, 'monitor');
  const stagedJournal = path.join(root, `attempt-${journal.nonce}`, 'journal.json');
  const extract = path.join(root, `extract-${journal.nonce}`);
  const failed = path.join(root, `failed-${journal.identity.revision}.json`);
  const requirement = appleDevelopmentRequirement('com.xd.cindy', journal.teamId);
  return [
    '#!/bin/bash', 'set -eu', 'umask 077',
    `JOURNAL=${q(record)}`, `LOCK=${q(lock)}`, `HELPER=${q(journal.helper)}`,
    `APP=${q(journal.canonicalApp)}`, `BACKUP=${q(journal.backup)}`, `HEALTH=${q(journal.health)}`,
    `REQUIREMENT=${q(requirement)}`,
    `EXIT_STATUS=${q(path.join(root, `attempt-${journal.nonce}`, 'exit-status.json'))}`,
    `EXTRACT=${q(extract)}`,
    "FAILURE_REASON=transaction_command_failed",
    'bundle_alive() {',
    `  if "$HELPER" --bundle-status "$APP" ${journal.previousPid} ${q(journal.previousProcessBirth ?? '-')} > "$EXIT_STATUS.tmp"; then`,
    '    /bin/mv "$EXIT_STATUS.tmp" "$EXIT_STATUS"', '    return 1',
    '  else', '    BUNDLE_STATUS=$?', '    /bin/mv "$EXIT_STATUS.tmp" "$EXIT_STATUS"',
    '    return 0', '  fi', '}',
    ...staleCrashpadFunctions(journal.previousPid),
    'wait_old_bundle() {',
    '  CRASHPAD_ONLY_SECONDS=0',
    '  for i in $(seq 1 "${1:-120}"); do',
    '    if ! bundle_alive; then return 0; fi',
    '    if only_stale_crashpad_left; then',
    '      LAST_WAIT_CRASHPAD_ONLY=1',
    '      CRASHPAD_ONLY_SECONDS=$((CRASHPAD_ONLY_SECONDS + 1))',
    '      if [ "$CRASHPAD_ONLY_SECONDS" -ge "$CRASHPAD_GRACE" ] && [ "$CRASHPAD_STOP_ROUNDS" -lt 2 ]; then',
    '        stop_stale_crashpad', '        CRASHPAD_ONLY_SECONDS=0',
    '      fi',
    '    else', '      LAST_WAIT_CRASHPAD_ONLY=0', '      CRASHPAD_ONLY_SECONDS=0', '    fi',
    '    sleep 1', '  done', '  return 1', '}',
    'phase() { /usr/bin/plutil -replace phase -string "$1" -o "$JOURNAL.tmp" "$JOURNAL" && /bin/mv "$JOURNAL.tmp" "$JOURNAL" && "$HELPER" --sync "$JOURNAL"; }',
    'matches() {',
    '  [ -d "$1" ] || return 1',
    '  /usr/bin/codesign --verify --deep --strict -R "=$REQUIREMENT" "$1" >/dev/null 2>&1 || return 1',
    '  [ "$(/usr/bin/plutil -extract personalUpdate.revision raw "$1/Contents/Resources/cindy-source.json")" = "$2" ] || return 1',
    '  [ "$(/usr/bin/plutil -extract sourceCommit raw "$1/Contents/Resources/cindy-source.json")" = "$3" ] || return 1',
    `  [ "$(/usr/bin/plutil -extract personalUpdate.storageIdentity raw "$1/Contents/Resources/cindy-source.json")" = ${q(journal.identity.storageIdentity)} ]`,
    '}',
    'swap() {',
    `  test "$(/usr/bin/shasum -a 256 "$HELPER" | /usr/bin/awk '{print $1}')" = ${q(journal.helperSha256)}`,
    '  "$HELPER" "$APP" "$BACKUP"',
    '}',
    'if [ "${1:-}" != "--recover" ]; then',
    '  if [ -f "$JOURNAL" ]; then',
    '    OLD_PHASE=$(/usr/bin/plutil -extract phase raw "$JOURNAL")',
    '    case "$OLD_PHASE" in committed|failed) ;; *) exit 75 ;; esac',
    '  fi',
    `  /bin/cp ${q(stagedJournal)} "$JOURNAL.tmp"`,
    '  /bin/mv "$JOURNAL.tmp" "$JOURNAL"',
    '  "$HELPER" --sync "$JOURNAL"',
    'else',
    `  [ "$(/usr/bin/plutil -extract nonce raw "$JOURNAL")" = ${q(journal.nonce)} ] || exit 75`,
    `  [ "$(/usr/bin/plutil -extract identity.revision raw "$JOURNAL")" = ${journal.identity.revision} ] || exit 75`,
    `  [ "$(/usr/bin/plutil -extract identity.sourceCommit raw "$JOURNAL")" = ${q(journal.identity.sourceCommit)} ] || exit 75`,
    `  [ "$(/usr/bin/plutil -extract identity.storageIdentity raw "$JOURNAL")" = ${q(journal.identity.storageIdentity)} ] || exit 75`,
    'fi',
    '/bin/mkdir -p "$LOCK"',
    // A failure before the exchange leaves this attempt's own new-app copy (BACKUP) and its extraction
    // unused. Remove exactly those, and only when the journal never reached `swapping`, the canonical app
    // still verifies as the previous revision, and the copy is a real directory verifying as this target.
    // A swapped, swapped-back, partial or otherwise unproven copy is kept for review.
    'discard_unswapped_copy() {',
    '  case "${FAILED_FROM:-}" in prepared|waiting-for-exit) ;; *) return 0 ;; esac',
    '  [ -d "$BACKUP" ] && [ ! -L "$BACKUP" ] || return 0',
    `  matches "$APP" ${journal.previousIdentity.revision} ${q(journal.previousIdentity.sourceCommit)} || return 0`,
    `  matches "$BACKUP" ${journal.identity.revision} ${q(journal.identity.sourceCommit)} || return 0`,
    '  /bin/rm -rf "$BACKUP" || return 1',
    '  if [ -d "$EXTRACT" ] && [ ! -L "$EXTRACT" ]; then /bin/rm -rf "$EXTRACT" || return 1; fi',
    `  printf '{"removed":true}\\n' > "\${EXIT_STATUS%/*}/unswapped-copy-removed.json" || true`,
    '}',
    'rollback() {',
    '  trap - EXIT HUP INT TERM',
    `  if matches "$APP" ${journal.identity.revision} ${q(journal.identity.sourceCommit)} && matches "$BACKUP" ${journal.previousIdentity.revision} ${q(journal.previousIdentity.sourceCommit)}; then`,
    `    PIDS=$(/usr/bin/pgrep -f '^/Applications/Cindy[.]app/Contents/MacOS/Cindy( |$)' || true)`,
    '    if [ -n "$PIDS" ]; then /bin/kill $PIDS 2>/dev/null || true; sleep 2; /bin/kill -9 $PIDS 2>/dev/null || true; fi',
    '    swap || true',
    '  fi',
    '  FAILED_FROM=$(/usr/bin/plutil -extract phase raw "$JOURNAL")',
    '  /usr/bin/plutil -replace failedFromPhase -string "$FAILED_FROM" "$JOURNAL" || true',
    '  /usr/bin/plutil -replace failureReason -string "$FAILURE_REASON" "$JOURNAL" || true',
    '  phase failed || true',
    `  /bin/cp "$JOURNAL" ${q(failed)}`,
    `  "$HELPER" --sync ${q(failed)} || true`,
    '  discard_unswapped_copy || true',
    '  /bin/rm -rf "$LOCK"',
    '  /usr/bin/open "$APP" || true',
    '}',
    'trap rollback EXIT HUP INT TERM',
    `printf '{"pid":%s,"nonce":"${journal.nonce}"}' "$$" > "$LOCK/owner.json"`,
    'if [ "${1:-}" != "--recover" ]; then',
    `test "$(/usr/bin/shasum -a 256 ${q(journal.zip)} | /usr/bin/awk '{print $1}')" = ${q(journal.sha256)}`,
    `mkdir -p ${q(extract)}`,
    `/usr/bin/ditto -x -k ${q(journal.zip)} ${q(extract)}`,
    `/usr/bin/ditto ${q(path.join(extract, 'Cindy.app'))} "$BACKUP"`,
    `matches "$BACKUP" ${journal.identity.revision} ${q(journal.identity.sourceCommit)}`,
    `matches "$APP" ${journal.previousIdentity.revision} ${q(journal.previousIdentity.sourceCommit)}`,
    'phase waiting-for-exit',
    'if ! wait_old_bundle; then',
    '  FAILURE_REASON=old_bundle_exit_timeout',
    '  if [ "$LAST_WAIT_CRASHPAD_ONLY" = 1 ]; then FAILURE_REASON=stale_crashpad_not_stopped; fi',
    '  if [ "${BUNDLE_STATUS:-2}" != 75 ]; then FAILURE_REASON=bundle_status_unavailable; fi',
    '  "$HELPER" --sync "$EXIT_STATUS" || true', '  exit 1', 'fi',
    'if bundle_alive; then FAILURE_REASON=bundle_reappeared_before_swap; exit 1; fi',
    'phase swapping', 'swap',
    'else',
    `if matches "$APP" ${journal.previousIdentity.revision} ${q(journal.previousIdentity.sourceCommit)}; then`,
    '  phase failed', `  /bin/cp "$JOURNAL" ${q(failed)}`,
    `  "$HELPER" --sync ${q(failed)} || true`,
    '  trap - EXIT HUP INT TERM', '  /bin/rm -rf "$LOCK"', '  exit 0', 'fi',
    `matches "$APP" ${journal.identity.revision} ${q(journal.identity.sourceCommit)}`,
    `matches "$BACKUP" ${journal.previousIdentity.revision} ${q(journal.previousIdentity.sourceCommit)}`,
    'fi',
    'phase awaiting-health', '/usr/bin/open "$APP"',
    'valid_health() {',
    '  [ -f "$HEALTH" ] || return 1',
    `    test "$(/usr/bin/plutil -extract nonce raw "$HEALTH")" = ${q(journal.nonce)} || return 1`,
    `    test "$(/usr/bin/plutil -extract revision raw "$HEALTH")" = ${journal.identity.revision} || return 1`,
    `    test "$(/usr/bin/plutil -extract storageIdentity raw "$HEALTH")" = ${q(journal.identity.storageIdentity)} || return 1`,
    '    test "$(/usr/bin/plutil -extract canonicalApp raw "$HEALTH")" = "$APP" || return 1',
    '    test "$(/usr/bin/plutil -extract storageOpened raw "$HEALTH")" = true || return 1',
    '    test "$(/usr/bin/plutil -extract coreReady raw "$HEALTH")" = true || return 1',
    `    test "$(/usr/bin/plutil -extract ownerIdentity raw "$HEALTH")" = ${q(journal.ownerIdentity)} || return 1`,
    '  PID=$(/usr/bin/plutil -extract pid raw "$HEALTH") || return 1',
    '  /bin/kill -0 "$PID" 2>/dev/null || return 1',
    '  [ "$("$HELPER" --pid-birth "$PID")" = "$(/usr/bin/plutil -extract processBirth raw "$HEALTH")" ] || return 1',
    `    matches "$APP" ${journal.identity.revision} ${q(journal.identity.sourceCommit)} || return 1`,
    '}',
    'for i in $(seq 1 180); do',
    '  if valid_health; then',
    '    phase committed',
    `    /bin/mkdir -p ${q(path.join(root, 'committed'))}`,
    `    RECEIPT=${q(path.join(root, 'committed', `${journal.nonce}.json`))}`,
    '    /bin/cp "$JOURNAL" "$RECEIPT.tmp"',
    `    /usr/bin/plutil -insert extract -string ${q(extract)} "$RECEIPT.tmp"`,
    `    /usr/bin/plutil -insert attempt -string ${q(path.join(root, `attempt-${journal.nonce}`))} "$RECEIPT.tmp"`,
    `    /usr/bin/plutil -insert script -string ${q(path.join(root, `attempt-${journal.nonce}`, 'apply.sh'))} "$RECEIPT.tmp"`,
    '    /bin/mv "$RECEIPT.tmp" "$RECEIPT"',
    '    "$HELPER" --sync "$RECEIPT"',
    '    "$HELPER" --sync "$JOURNAL"',
    '    trap - EXIT HUP INT TERM', '    /bin/rm -rf "$LOCK"', '    exit 0',
    '  fi', '  sleep 1', 'done', 'exit 1', '',
  ].join('\n');
}

export async function launchPersonalTransaction(root: string, identity: PersonalIdentity, zip: string, sha256: string, pid: number, previousIdentity: PersonalIdentity, teamId: string, helperSource: string, ownerIdentity: string): Promise<void> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const lock = path.join(root, `attempt-${nonce}`, 'monitor');
  const attempt = path.join(root, `attempt-${nonce}`);
  fs.mkdirSync(attempt, { mode: 0o700 });
  const helper = path.join(attempt, 'swap-apps');
  const helperIdentifier = readLocalSigningIdentifier(helperSource, '/Applications/Cindy.app');
  verifyAppleDevelopmentSignature(helperSource, helperIdentifier, teamId);
  fs.copyFileSync(helperSource, helper);
  fs.chmodSync(helper, 0o700);
  verifyAppleDevelopmentSignature(helper, helperIdentifier, teamId);
  const helperSha256 = fileSha256(helper);
  if (helperSha256 !== fileSha256(helperSource)) throw new Error('Personal updater helper copy mismatch');
  const birth = spawnSync(helper, ['--pid-birth', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  const previousProcessBirth = birth.stdout?.trim();
  if (birth.status !== 0 || !/^\d+:\d+$/.test(previousProcessBirth)) throw new Error('Previous process identity unavailable');
  const journal: PersonalJournal = { schemaVersion: 1, nonce, phase: 'prepared', identity, previousProcessBirth,
    canonicalApp: '/Applications/Cindy.app', backup: `/Applications/.Cindy-personal-backup-${nonce}.app`,
    health: path.join(root, `health-${nonce}.json`), previousPid: pid, zip, sha256, previousIdentity, helper, helperSha256, teamId, ownerIdentity };
    writeAtomicJson(path.join(attempt, 'journal.json'), journal);
    const script = path.join(attempt, 'apply.sh');
    fs.writeFileSync(script, buildPersonalMacTransaction(journal, root), { mode: 0o700 });
    const child = spawn(helper, ['--lock', path.join(root, 'transaction-process.lock'), script], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        const deadline = Date.now() + 5_000;
        const poll = () => {
          try {
            const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
            if (owner.pid === child.pid && owner.nonce === nonce) { child.unref(); resolve(); return; }
          } catch { /* Wait until the exclusively locked monitor publishes its PID. */ }
          if (Date.now() > deadline || child.exitCode !== null) { reject(new Error('Personal monitor did not acquire its lock')); return; }
          setTimeout(poll, 25);
        };
        poll();
      });
    });
}

/** Resume only a journal whose currently installed signed identity proves the swap outcome. */
export function resumePersonalTransaction(root: string, canonicalApp: string, identity: PersonalIdentity): void {
  const file = path.join(root, 'transaction.json');
  if (!fs.existsSync(file)) return;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as PersonalJournal;
  buildPersonalMacTransaction(journal, root); // Validate every path before any recovery write/spawn.
  if (journal.phase === 'committed' || journal.phase === 'failed') return;
  if (canonicalApp !== journal.canonicalApp || identity.storageIdentity !== journal.identity.storageIdentity) throw new Error('Personal recovery storage/canonical mismatch');
  const isPrevious = identity.revision === journal.previousIdentity.revision && identity.sourceCommit === journal.previousIdentity.sourceCommit;
  if (!isPrevious && (identity.revision !== journal.identity.revision || identity.sourceCommit !== journal.identity.sourceCommit)) throw new Error('Personal recovery revision mismatch');
  verifyAppleDevelopmentSignature(canonicalApp, 'com.xd.cindy', journal.teamId);
  if (!isPrevious) verifyAppleDevelopmentSignature(journal.backup, 'com.xd.cindy', journal.teamId);
  if (fileSha256(journal.helper) !== journal.helperSha256) throw new Error('Personal recovery helper changed');
  const helperIdentifier = readLocalSigningIdentifier(journal.helper, canonicalApp);
  verifyAppleDevelopmentSignature(journal.helper, helperIdentifier, journal.teamId);
  const script = path.join(root, `attempt-${journal.nonce}`, `recover-${randomUUID()}.sh`);
  fs.writeFileSync(script, buildPersonalMacTransaction(journal, root), { mode: 0o700 });
  const child = spawn(journal.helper, ['--lock', path.join(root, 'transaction-process.lock'), script, '--recover'], { detached: true, stdio: 'ignore' });
  child.unref();
  child.once('error', () => { /* Keep the journal and backup for explicit recovery. */ });
}


/** Fail closed for updates while leaving an independently valid canonical App usable. */
export function resumePersonalTransactionSafely(root: string, canonicalApp: string, identity: PersonalIdentity): boolean {
  try { resumePersonalTransaction(root, canonicalApp, identity); return true; }
  catch {
    try { writeAtomicJson(path.join(root, 'recovery-blocked.json'), { code: 'PERSONAL_UPDATE_RECOVERY_REQUIRES_REVIEW' }); }
    catch { /* An unwritable update cache must not brick normal application startup. */ }
    return false;
  }
}
