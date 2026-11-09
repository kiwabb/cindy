import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeAtomicJson } from './transaction.js';

interface JobRecord {
  schemaVersion: 1;
  ownerPid: number;
  ownerBirth: string;
  workerPid: number | null;
  workerBirth: string | null;
  jobDirectory: string;
}

function birthtime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PERSONAL_UPDATE_JOB_PID_INVALID');
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4096 });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('PERSONAL_UPDATE_JOB_PROCESS_UNKNOWN');
  return result.stdout.trim() || null;
}

function readJob(root: string): JobRecord {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'prepare.lock', 'owner.json'), 'utf8')) as JobRecord;
  const basename = path.basename(record.jobDirectory);
  if (record.schemaVersion !== 1 || !/^job-[a-f0-9-]{36}$/.test(basename)
    || record.jobDirectory !== path.join(root, basename) || !record.ownerBirth
    || (record.workerPid !== null && !record.workerBirth)) throw new Error('PERSONAL_UPDATE_JOB_RECORD_INVALID');
  return record;
}

/** Only dead, exactly recorded updater jobs can be reclaimed after a crash. */
export async function cleanupAbandonedPreparation(root: string): Promise<void> {
  const lock = path.join(root, 'prepare.lock');
  if (!fs.existsSync(lock)) return;
  const record = readJob(root);
  if (birthtime(record.ownerPid) === record.ownerBirth) throw new Error('PERSONAL_UPDATE_PREPARE_BUSY');
  if (record.workerPid !== null && birthtime(record.workerPid) === record.workerBirth) throw new Error('PERSONAL_UPDATE_PREPARE_WORKER_BUSY');
  await waitForSupervisors(record.jobDirectory);
  await fs.promises.rm(record.jobDirectory, { recursive: true, force: true });
  await fs.promises.rm(lock, { recursive: true });
}

export async function createPreparationJob(root: string): Promise<string> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  await cleanupAbandonedPreparation(root);
  const lock = path.join(root, 'prepare.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  const jobDirectory = path.join(root, `job-${randomUUID()}`);
  fs.mkdirSync(jobDirectory, { mode: 0o700 });
  fs.mkdirSync(path.join(jobDirectory, 'supervisors'), { mode: 0o700 });
  const ownerBirth = birthtime(process.pid);
  if (!ownerBirth) throw new Error('PERSONAL_UPDATE_JOB_OWNER_UNKNOWN');
  writeAtomicJson(path.join(lock, 'owner.json'), { schemaVersion: 1, ownerPid: process.pid, ownerBirth,
    workerPid: null, workerBirth: null, jobDirectory });
  return jobDirectory;
}

export function recordPreparationWorker(root: string, jobDirectory: string, workerPid: number): void {
  const record = readJob(root);
  if (record.jobDirectory !== jobDirectory || record.ownerPid !== process.pid) throw new Error('PERSONAL_UPDATE_JOB_OWNER_CHANGED');
  const workerBirth = birthtime(workerPid);
  if (!workerBirth) throw new Error('PERSONAL_UPDATE_JOB_WORKER_UNKNOWN');
  writeAtomicJson(path.join(root, 'prepare.lock', 'owner.json'), { ...record, workerPid, workerBirth });
}

/** Called only after the worker exited and its native supervisors had time to reap children. */
export async function finishPreparationJob(root: string, jobDirectory: string): Promise<void> {
  const record = readJob(root);
  if (record.jobDirectory !== jobDirectory || record.ownerPid !== process.pid) throw new Error('PERSONAL_UPDATE_JOB_OWNER_CHANGED');
  await waitForSupervisors(jobDirectory);
  await fs.promises.rm(jobDirectory, { recursive: true, force: true });
  await fs.promises.rm(path.join(root, 'prepare.lock'), { recursive: true });
}

async function waitForSupervisors(jobDirectory: string): Promise<void> {
  const helper = '/Applications/Cindy.app/Contents/Resources/tools/personal-update/swap-apps';
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync(helper, ['--job-idle', path.join(jobDirectory, 'supervisors')], { timeout: 2_000 });
    if (result.status === 0) return;
    if (result.status !== 75) throw new Error('PERSONAL_UPDATE_JOB_SUPERVISOR_UNKNOWN');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('PERSONAL_UPDATE_JOB_SUPERVISOR_BUSY');
}
