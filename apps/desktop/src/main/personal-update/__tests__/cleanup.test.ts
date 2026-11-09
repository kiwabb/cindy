import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalIdentity } from '../contract.mjs';
import type { CommittedPersonalUpdateReceipt } from '../cleanup';

// Real temporary filesystem fixtures with explicit fake code-signing and OS-lease
// responses. No application, account, Keychain, profile or model is started.
const h = vi.hoisted(() => ({ busy: false, held: false, badSignatures: new Set<string>(),
  execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: h.execFile, spawn: h.spawn }));
const { cleanupCommittedPersonalUpdates } = await import('../cleanup');

const teamId = 'ABCDEFGHIJ';
const storageIdentity = 'b'.repeat(64);
const roots: string[] = [];
function identity(revision: number): PersonalIdentity {
  return { schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64',
    revision, sourceCommit: revision.toString(16).padStart(40, '0'), platform: 'darwin',
    arch: 'arm64', region: 'global', bundleIdentifier: 'com.xd.cindy', storageIdentity };
}
async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
async function writeApp(app: string, value: PersonalIdentity) {
  await writeJson(path.join(app, 'Contents/Resources/cindy-source.json'), {
    sourceCommit: value.sourceCommit, personalUpdate: value,
  });
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-committed-cleanup-test-'));
  roots.push(directory);
  const root = path.join(directory, 'updates');
  const canonicalApp = path.join(directory, 'Applications/Cindy.app');
  await writeApp(canonicalApp, identity(4));
  const helper = path.join(canonicalApp, 'Contents/Resources/tools/personal-update/swap-apps');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.writeFile(helper, 'unit current signed helper bytes');
  const receipts: CommittedPersonalUpdateReceipt[] = [];
  for (const revision of [2, 3, 4]) {
    const nonce = randomUUID(), attempt = path.join(root, `attempt-${nonce}`);
    const zipBytes = `unit prepared ZIP bytes ${revision}`, helperBytes = `unit helper ${revision}`;
    const receipt: CommittedPersonalUpdateReceipt = { schemaVersion: 1, phase: 'committed', nonce,
      identity: identity(revision), previousIdentity: identity(revision - 1), canonicalApp,
      backup: path.join(path.dirname(canonicalApp), `.Cindy-personal-backup-${nonce}.app`),
      health: path.join(root, `health-${nonce}.json`), previousPid: 123,
      zip: path.join(root, `personal-${revision}.zip`), sha256: createHash('sha256').update(zipBytes).digest('hex'),
      helper: path.join(attempt, 'swap-apps'), helperSha256: createHash('sha256').update(helperBytes).digest('hex'),
      teamId, ownerIdentity: 'e'.repeat(64), extract: path.join(root, `extract-${nonce}`),
      attempt, script: path.join(attempt, 'apply.sh') };
    await writeApp(receipt.backup, receipt.previousIdentity);
    await fs.mkdir(attempt, { recursive: true });
    await fs.writeFile(receipt.helper, helperBytes);
    await fs.writeFile(receipt.script, 'unit owned script');
    await fs.writeFile(path.join(attempt, `recover-${randomUUID()}.sh`), 'unit recovery script');
    await writeApp(path.join(receipt.extract, 'Cindy.app'), receipt.identity);
    await fs.writeFile(receipt.zip, zipBytes);
    await writeJson(receipt.health, { nonce });
    await writeJson(path.join(root, 'committed', `${nonce}.json`), receipt);
    receipts.push(receipt);
  }
  const journal = Object.fromEntries(Object.entries(receipts[2])
    .filter(([key]) => !['extract', 'attempt', 'script'].includes(key)));
  await writeJson(path.join(root, 'transaction.json'), journal);
  return { root, canonicalApp, context: { canonicalApp, teamId }, receipts, helper, directory };
}
async function exists(file: string) { return fs.lstat(file).then(() => true, () => false); }

beforeEach(() => {
  h.busy = false; h.held = false; h.badSignatures.clear();
  h.execFile.mockReset(); h.spawn.mockReset();
  h.execFile.mockImplementation((_command, args: string[], _options, callback) => {
    const file = args.at(-1)!;
    if (h.badSignatures.has(file)) callback(new Error('Unit signature rejection'), '', '');
    else callback(null, '', `Identifier=${file.endsWith('swap-apps') ? 'com.xd.cindy.updater' : 'com.xd.cindy'}\nTeamIdentifier=${teamId}\n`);
  });
  h.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
      kill: vi.fn() });
    child.stdin.on('finish', () => {
      h.held = false; child.exitCode = 0; child.emit('exit', 0);
    });
    child.kill.mockImplementation(() => {
      h.held = false; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true;
    });
    queueMicrotask(() => {
      if (h.busy) { child.exitCode = 75; child.emit('exit', 75); }
      else { h.held = true; child.stdout.write('READY\n'); }
    });
    return child;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('committed personal update cleanup', () => {
  it('holds the OS lease across cleanup and retains exactly the latest verified backup', async () => {
    const value = await fixture();
    const remove = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, 'rm').mockImplementation((file, options) => {
      expect(h.held).toBe(true);
      return remove(file, options);
    });
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    spy.mockRestore();
    expect(h.spawn).toHaveBeenCalledWith(value.helper,
      ['--hold-lock', path.join(value.root, 'transaction-process.lock')], { stdio: 'pipe' });
    expect(h.held).toBe(false);
    for (const receipt of value.receipts) {
      expect(await exists(receipt.backup)).toBe(receipt.identity.revision === 4);
      for (const file of [receipt.zip, receipt.extract, receipt.attempt, receipt.health]) expect(await exists(file)).toBe(false);
      expect(await exists(path.join(value.root, 'committed', `${receipt.nonce}.json`))).toBe(receipt.identity.revision === 4);
    }
    expect(await exists(value.canonicalApp)).toBe(true);
    expect(await exists(value.helper)).toBe(true);
  });

  it.each(['busy', 'active', 'canonical-source', 'missing-current-receipt'] as const)
  ('preserves all work when %s prevents proof of a committed current install', async reason => {
    const value = await fixture();
    if (reason === 'busy') h.busy = true;
    if (reason === 'active') await writeJson(path.join(value.root, 'transaction.json'), { ...value.receipts[2], phase: 'awaiting-health' });
    if (reason === 'canonical-source') await writeApp(value.canonicalApp, identity(5));
    if (reason === 'missing-current-receipt') await fs.unlink(path.join(value.root, 'committed', `${value.receipts[2].nonce}.json`));
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    for (const receipt of value.receipts) expect(await exists(receipt.zip)).toBe(true);
    expect(h.held).toBe(false);
  });

  it('preserves malformed, forged-path, failed and unowned diagnostics', async () => {
    const value = await fixture(), first = value.receipts[0];
    const receiptPath = path.join(value.root, 'committed', `${first.nonce}.json`);
    await writeJson(receiptPath, { ...first, backup: value.canonicalApp });
    const malformed = path.join(value.root, 'committed', `${randomUUID()}.json`);
    await fs.writeFile(malformed, '{bad JSON');
    const failed = path.join(value.root, 'failed-100.json'); await writeJson(failed, { phase: 'failed' });
    const unknown = path.join(value.root, `extract-${randomUUID()}`); await fs.mkdir(unknown);
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    for (const file of [receiptPath, first.backup, first.zip, malformed, failed, unknown, value.canonicalApp]) expect(await exists(file)).toBe(true);
  });

  it('retains mismatching signatures, ZIPs and symlinked directories for diagnosis', async () => {
    const value = await fixture(), first = value.receipts[0], second = value.receipts[1];
    h.badSignatures.add(first.backup);
    await fs.writeFile(second.zip, 'changed unit ZIP');
    const outside = path.join(value.directory, 'retained-user-files'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'retained');
    const current = value.receipts[2];
    await fs.rm(current.extract, { recursive: true }); await fs.symlink(outside, current.extract);
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    for (const file of [first.backup, first.zip, first.attempt, second.zip, second.attempt, current.extract,
      current.attempt, path.join(outside, 'keep')]) expect(await exists(file)).toBe(true);
  });

  it('is idempotent after successful owned cleanup', async () => {
    const value = await fixture();
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    expect(await exists(value.receipts[2].backup)).toBe(true);
    expect(await exists(value.canonicalApp)).toBe(true);
  });

  it('rereads the global journal after acquiring the lease and leaves a newly pending recovery intact', async () => {
    const value = await fixture();
    const spawn = h.spawn.getMockImplementation()!;
    h.spawn.mockImplementationOnce((...args) => {
      const child = spawn(...args);
      // Simulate recovery taking over after signature checks but before lease READY.
      child.stdout.once('data', () => writeFileSync(path.join(value.root, 'transaction.json'),
        JSON.stringify({ ...value.receipts[2], phase: 'awaiting-health' })));
      return child;
    });
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    for (const receipt of value.receipts) {
      for (const file of [receipt.backup, receipt.zip, receipt.extract, receipt.attempt, receipt.health]) {
        expect(await exists(file)).toBe(true);
      }
    }
    expect(h.held).toBe(false);
  });

  it('retains the newest remaining verified backup if the latest backup was already removed', async () => {
    const value = await fixture();
    await fs.rm(value.receipts[2].backup, { recursive: true });
    await cleanupCommittedPersonalUpdates(value.root, identity(4), value.context);
    expect(await exists(value.receipts[1].backup)).toBe(true);
    expect(await exists(value.receipts[0].backup)).toBe(false);
    expect(await exists(value.canonicalApp)).toBe(true);
  });
});
