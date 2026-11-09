import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ helper: '' }));
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawnSync: (command: string, args: string[], options: object) => real.spawnSync(
    command === '/Applications/Cindy.app/Contents/Resources/tools/personal-update/swap-apps' ? fixture.helper : command,
    args, options,
  ) };
});
import { createPreparationJob, finishPreparationJob, cleanupAbandonedPreparation, recordPreparationWorker } from '../jobs';

describe.skipIf(process.platform !== 'darwin')('parent-owned preparation workspace', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-jobs-test-'));
    fixture.helper = path.join(root, 'fixture-helper');
    expect(spawnSync('/usr/bin/xcrun', ['clang', path.resolve(import.meta.dirname, '../../../../native/personal-update/swap-apps.c'), '-o', fixture.helper]).status).toBe(0);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('preserves a live preparation and only removes its own recorded workspace', async () => {
    const updates = path.join(root, 'live'), job = await createPreparationJob(updates);
    const sibling = path.join(updates, 'unrelated'); fs.mkdirSync(sibling);
    await expect(createPreparationJob(updates)).rejects.toThrow('BUSY');
    expect(fs.existsSync(job)).toBe(true);
    await finishPreparationJob(updates, job);
    expect(fs.existsSync(job)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('distinguishes reused owner PIDs and preserves a genuinely live worker', async () => {
    const updates = path.join(root, 'reused'), job = await createPreparationJob(updates);
    recordPreparationWorker(updates, job, process.pid);
    const file = path.join(updates, 'prepare.lock', 'owner.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.ownerBirth = 'different process birth'; fs.writeFileSync(file, JSON.stringify(record));
    await expect(cleanupAbandonedPreparation(updates)).rejects.toThrow('WORKER_BUSY');
    expect(fs.existsSync(job)).toBe(true);
    record.workerPid = null; record.workerBirth = null; fs.writeFileSync(file, JSON.stringify(record));
    await cleanupAbandonedPreparation(updates);
    expect(fs.existsSync(job)).toBe(false);
  });

  it('rejects a ledger pointing outside the exact owned job directory', async () => {
    const updates = path.join(root, 'escape'), job = await createPreparationJob(updates);
    const file = path.join(updates, 'prepare.lock', 'owner.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.jobDirectory = root; fs.writeFileSync(file, JSON.stringify(record));
    await expect(cleanupAbandonedPreparation(updates)).rejects.toThrow('RECORD_INVALID');
    expect(fs.existsSync(job)).toBe(true);
  });

  it('waits for a real native supervisor lease before deleting a dead worker workspace', async () => {
    const updates = path.join(root, 'supervisor'), job = await createPreparationJob(updates);
    const supervisor = spawn(fixture.helper, ['--run', String(process.pid), '5', '/bin/sleep', '1'], {
      env: { ...process.env, CINDY_UPDATE_SUPERVISOR_LEDGER: path.join(job, 'supervisors') },
    });
    await expect.poll(() => fs.readdirSync(path.join(job, 'supervisors')).length).toBe(1);
    expect(spawnSync(fixture.helper, ['--job-idle', path.join(job, 'supervisors')]).status).toBe(75);
    const exited = new Promise(resolve => supervisor.once('exit', resolve));
    await finishPreparationJob(updates, job);
    await exited;
    expect(fs.existsSync(job)).toBe(false);
  });
});
