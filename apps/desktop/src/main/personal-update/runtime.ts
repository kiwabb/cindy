import { app, net } from 'electron';
// This trusted updater worker performs code signing and smoke execution, never database access.
// eslint-disable-next-line no-restricted-imports
import { utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validatePersonalIdentity, validatePersonalManifest, validatePersonalPolicy, type PersonalManifest, type PersonalIdentity } from './contract.mjs';
import policyValue from '../../../personal-update-channel.json';
import { writeAtomicJson, acknowledgePersonalStorageReady, launchPersonalTransaction, resumePersonalTransactionSafely } from './transaction.js';
import type { PreparationRequest } from './prepareProcess.js';

import { cleanupCommittedPersonalUpdates } from './cleanup.js';
import { readLocalSigningIdentity } from './signing-core.mjs';
import { createPreparationJob, recordPreparationWorker, finishPreparationJob, cleanupAbandonedPreparation } from './jobs.js';

const policy = validatePersonalPolicy(policyValue);
export function personalUpdateContext() {
  try {
    if (!app.isPackaged || process.platform !== 'darwin' || process.arch !== 'arm64'
      || app.getPath('exe') !== '/Applications/Cindy.app/Contents/MacOS/Cindy') return null;
    const configuration = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'personal-app-update.json'), 'utf8'));
    if (configuration.enabled !== true || Object.keys(configuration).some(key => key !== 'enabled')) return null;
    const metadata = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'cindy-source.json'), 'utf8'));
    const identity = validatePersonalIdentity(metadata.personalUpdate, policy);
    if (metadata.sourceCommit !== identity.sourceCommit) return null;
    return { policy, identity, root: path.join(app.getPath('userData'), 'personal-app-updates') };
  } catch { return null; }
}

export async function checkPersonalManifest(): Promise<PersonalManifest | null> {
  const context = personalUpdateContext();
  if (!context) return null;
  if (fs.existsSync(path.join(context.root, 'recovery-blocked.json'))) throw new Error('PERSONAL_UPDATE_RECOVERY_BLOCKED');
  const response = await net.fetch(context.policy.feedUrl, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!response.ok) throw new Error('PERSONAL_UPDATE_FEED_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 32 * 1024) throw new Error('PERSONAL_UPDATE_FEED_TOO_LARGE');
  const manifest = validatePersonalManifest(JSON.parse(text), context.policy);
  if (manifest.storageIdentity !== context.identity.storageIdentity) throw new Error('PERSONAL_UPDATE_STORAGE_INCOMPATIBLE');
  if (manifest.revision <= context.identity.revision || fs.existsSync(path.join(context.root, `failed-${manifest.revision}.json`))) return null;
  return manifest;
}

interface Prepared { path: string; sha256: string; size: number; identity: PersonalIdentity; teamId: string }
export async function prepareInUtilityProcess(archive: string, manifest: PersonalManifest): Promise<Prepared> {
  const context = personalUpdateContext();
  if (!context) throw new Error('PERSONAL_UPDATE_DISABLED');
  const jobDirectory = await createPreparationJob(context.root);
  let workerExited = true;
  try {
    const result = await new Promise<Prepared>((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'prepareProcess.js'), [], { serviceName: 'Personal app update preparation', stdio: 'ignore' });
      workerExited = false;
      let done = false;
      const finish = async (error?: Error, value?: Prepared) => {
        if (done) return;
        done = true; clearTimeout(timer); child.kill();
        if (!workerExited) await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise(resolve => setTimeout(resolve, 5_000))]);
        if (workerExited) {
          // Native supervisors observe parent death at 100ms intervals and reap only their own children.
          try { await finishPreparationJob(context.root, jobDirectory); }
          catch { error = new Error('PERSONAL_UPDATE_JOB_CLEANUP_BLOCKED'); }
        }
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => finish(new Error('PERSONAL_UPDATE_PREPARE_TIMEOUT')), 30 * 60_000);
      child.once('exit', () => { workerExited = true; void finish(new Error('PERSONAL_UPDATE_PREPARE_EXIT')); });
      child.once('message', message => {
        try {
          const value = message as { ok?: boolean; result?: Prepared };
          if (value.ok !== true || !value.result) return finish(new Error('PERSONAL_UPDATE_PREPARATION_FAILED'));
          const candidate = value.result;
          const expectedPath = path.join(context.root, `personal-${manifest.revision}.zip`);
          const candidateIdentity = validatePersonalIdentity(candidate.identity, context.policy);
          if (JSON.stringify(candidateIdentity) !== JSON.stringify(validatePersonalIdentity(manifest, context.policy))
          || !Number.isSafeInteger(candidate.size) || candidate.size <= 0
          || candidate.path !== expectedPath || !/^[a-f0-9]{64}$/.test(candidate.sha256)
          || !/^[A-Z0-9]{10}$/.test(candidate.teamId) || candidate.identity.revision !== manifest.revision
          || candidate.identity.storageIdentity !== context.identity.storageIdentity || fs.statSync(expectedPath).size !== candidate.size) {
          return finish(new Error('PERSONAL_UPDATE_PREPARED_RESULT_INVALID'));
        }
          writeAtomicJson(path.join(context.root, 'ready.json'), candidate);
          finish(undefined, candidate);
        } catch { finish(new Error('PERSONAL_UPDATE_PREPARED_RESULT_INVALID')); }
      });
      const request: PreparationRequest = { archive, manifest, policy: context.policy,
        outputDirectory: context.root, jobDirectory, storageIdentity: context.identity.storageIdentity };
      child.once('spawn', () => {
        try {
          if (!child.pid) throw new Error('PERSONAL_UPDATE_WORKER_PID_UNKNOWN');
          recordPreparationWorker(context.root, jobDirectory, child.pid);
          child.postMessage(request);
        } catch { void finish(new Error('PERSONAL_UPDATE_WORKER_START_FAILED')); }
      });
    });
    return result;
  } catch (error) {
    writeAtomicJson(path.join(context.root, `failed-${manifest.revision}.json`), { revision: manifest.revision, phase: 'preparation-failed' });
    throw error;
  } finally {
    // A still-live worker retains its exact job ledger for later safe cleanup.
    if (workerExited && fs.existsSync(jobDirectory)) {
      try { await finishPreparationJob(context.root, jobDirectory); } catch { /* Keep exact ledger until a later safe cleanup. */ }
    }
  }
}

export function readPreparedPersonalUpdate(): Prepared | null {
  const context = personalUpdateContext();
  if (!context || fs.existsSync(path.join(context.root, 'recovery-blocked.json'))) return null;
  try {
    const candidate = JSON.parse(fs.readFileSync(path.join(context.root, 'ready.json'), 'utf8')) as Prepared;
    const identity = validatePersonalIdentity(candidate.identity, context.policy);
    if (identity.revision <= context.identity.revision || identity.storageIdentity !== context.identity.storageIdentity
      || fs.existsSync(path.join(context.root, `failed-${identity.revision}.json`))
      || !/^[A-Z0-9]{10}$/.test(candidate.teamId) || !/^[a-f0-9]{64}$/.test(candidate.sha256)
      || !Number.isSafeInteger(candidate.size) || candidate.size <= 0
      || candidate.path !== path.join(context.root, `personal-${identity.revision}.zip`)
      || fs.statSync(candidate.path).size !== candidate.size) return null;
    return candidate;
  } catch { return null; }
}

export async function applyPreparedPersonalUpdate(zip: string): Promise<void> {
  const context = personalUpdateContext(), candidate = readPreparedPersonalUpdate();
  if (!context || !candidate || candidate.path !== zip) throw new Error('PERSONAL_UPDATE_READY_INVALID');
  const { getActiveAppSession } = await import('../appSessionState.js');
  const session = getActiveAppSession();
  if (!session.dataOwnerId || session.mode === 'signed-out') throw new Error('PERSONAL_UPDATE_OWNER_UNAVAILABLE');
  const ownerIdentity = createHash('sha256').update(`${session.mode}\0${session.dataOwnerId}`).digest('hex');
  await launchPersonalTransaction(context.root, candidate.identity, zip, candidate.sha256, process.pid,
    context.identity, candidate.teamId, path.join(process.resourcesPath, 'tools', 'personal-update', 'swap-apps'), ownerIdentity);
}

let storageReadyOwner: string | null = null;
let rendererReadyOwner: string | null = null;
let storageReadyGeneration: number | null = null;
let rendererReadyGeneration: number | null = null;

function acknowledgeReadyOwner(): void {
  if (!storageReadyOwner || storageReadyOwner !== rendererReadyOwner || storageReadyGeneration !== rendererReadyGeneration) return;
  const context = personalUpdateContext();
  if (!context) return;
  const result = spawnSync(path.join(process.resourcesPath, 'tools', 'personal-update', 'swap-apps'),
    ['--pid-birth', String(process.pid)], { encoding: 'utf8', timeout: 2_000 });
  const birth = result.stdout?.trim();
  if (result.status === 0 && /^\d+:\d+$/.test(birth)) {
    if (acknowledgePersonalStorageReady(context.root, '/Applications/Cindy.app', context.identity, storageReadyOwner, birth)) {
      observeCommittedCleanup(context);
    }
  }
}

export function notePersonalStorageOpened(ownerId: string, mode: string, generation: number): void {
  storageReadyGeneration = generation;
  storageReadyOwner = createHash('sha256').update(`${mode}\0${ownerId}`).digest('hex');
  acknowledgeReadyOwner();
}

export function notePersonalRendererCommitted(ownerId: string, mode: string, generation: number): void {
  rendererReadyGeneration = generation;
  rendererReadyOwner = createHash('sha256').update(`${mode}\0${ownerId}`).digest('hex');
  acknowledgeReadyOwner();
}

export async function resumePersonalUpdateStartup(): Promise<void> {
  const context = personalUpdateContext();
  if (!context) return;
  try { await cleanupAbandonedPreparation(context.root); } catch { /* A live/unknown job is preserved and preparation stays blocked. */ }
  resumePersonalTransactionSafely(context.root, '/Applications/Cindy.app', context.identity);
  void cleanCommitted(context);
}


async function cleanCommitted(context: NonNullable<ReturnType<typeof personalUpdateContext>>): Promise<void> {
  try {
    const signing = readLocalSigningIdentity();
    if (signing.signingKind !== 'apple-development' || typeof signing.teamId !== 'string') return;
    await cleanupCommittedPersonalUpdates(context.root, context.identity,
      { canonicalApp: '/Applications/Cindy.app', teamId: signing.teamId });
  } catch { /* Preserve unknown artifacts; cleanup never changes normal startup. */ }
}

let observingCommit = false;
function observeCommittedCleanup(context: NonNullable<ReturnType<typeof personalUpdateContext>>): void {
  if (observingCommit) return;
  observingCommit = true;
  let watcher: fs.FSWatcher | undefined;
  let scheduled = false;
  const stop = () => { watcher?.close(); clearTimeout(deadline); };
  const check = () => {
    if (scheduled) return;
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(context.root, 'transaction.json'), 'utf8'));
      if (journal.phase !== 'committed' || journal.identity?.revision !== context.identity.revision) return;
      scheduled = true;
      stop();
      // The monitor publishes its durable receipt before releasing the same kernel lease.
      // Cleanup itself acquires that lease. Bounded retries cover this short handoff.
      void (async () => {
        for (const delay of [0, 250, 1_000, 3_000]) {
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          await cleanCommitted(context);
          if (!fs.existsSync(path.join(context.root, `personal-${context.identity.revision}.zip`))) break;
        }
      })();
    } catch { /* Wait for an atomic journal publication. */ }
  };
  const deadline = setTimeout(stop, 180_000);
  deadline.unref();
  try { watcher = fs.watch(context.root, { persistent: false }, (_event, name) => { if (name === 'transaction.json') check(); }); }
  catch { stop(); }
  check();
}
