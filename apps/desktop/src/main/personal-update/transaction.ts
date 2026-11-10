import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { validatePersonalIdentity, validatePersonalPolicy, type PersonalIdentity } from './contract.mjs';
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
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
  const policy = validatePersonalPolicy(policyValue);
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
    "FAILURE_REASON=transaction_command_failed",
    'bundle_alive() {',
    `  if "$HELPER" --bundle-status "$APP" ${journal.previousPid} ${q(journal.previousProcessBirth ?? '-')} > "$EXIT_STATUS.tmp"; then`,
    '    /bin/mv "$EXIT_STATUS.tmp" "$EXIT_STATUS"', '    return 1',
    '  else', '    BUNDLE_STATUS=$?', '    /bin/mv "$EXIT_STATUS.tmp" "$EXIT_STATUS"',
    '    return 0', '  fi', '}',
    'wait_old_bundle() {',
    '  for i in $(seq 1 "${1:-120}"); do',
    '    if ! bundle_alive; then return 0; fi',
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
