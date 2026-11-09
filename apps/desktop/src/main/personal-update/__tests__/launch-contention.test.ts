import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// These fixtures exercise production journal/lease handling, with no installed App or keychain access.
vi.mock('../signing-core.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../signing-core.mjs')>(),
  verifyAppleDevelopmentSignature: vi.fn(),
  readLocalSigningIdentifier: vi.fn(() => 'com.example.fixture-swap'),
}));
import { launchPersonalTransaction, buildPersonalMacTransaction } from '../transaction';
import { validatePersonalIdentity, validatePersonalPolicy } from '../contract.mjs';

const policy = validatePersonalPolicy({ schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64',
  feedUrl: 'https://github.com/kiwabb/cindy/releases/download/personal-macos-arm64/personal-update.json', storageCompatibilityVersion: 1 });
const identity = validatePersonalIdentity({ schemaVersion: 1, repository: policy.repository, channel: policy.channel,
  revision: 42, sourceCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', region: 'global',
  bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64) }, policy);

describe.skipIf(process.platform !== 'darwin')('production personal launch contention', () => {
  it('cannot overwrite an active monitor journal or owner when two further launches lose the kernel lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-launch-test-'));
    let holder: ChildProcess | undefined;
    try {
      const helper = path.join(root, 'fixture-helper');
      const build = spawnSync('/usr/bin/xcrun', ['clang', path.resolve(import.meta.dirname, '../../../../native/personal-update/swap-apps.c'), '-o', helper]);
      expect(build.status).toBe(0);
      holder = spawn(helper, ['--hold-lock', path.join(root, 'transaction-process.lock')], { stdio: ['pipe', 'pipe', 'ignore'] });
      await new Promise<void>((resolve, reject) => { holder!.once('error', reject); holder!.stdout!.once('data', () => resolve()); });
      const originalJournal = '{"phase":"awaiting-health","fixture":"active-monitor"}';
      const journal = path.join(root, 'transaction.json'); fs.writeFileSync(journal, originalJournal);
      const owner = path.join(root, 'existing-owner.json'); fs.writeFileSync(owner, 'active-owner');
      const zip = path.join(root, 'personal-42.zip'); fs.writeFileSync(zip, 'archive-fixture');
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(launchPersonalTransaction(root, identity, zip, 'c'.repeat(64), process.pid,
          { ...identity, revision: 41 }, 'ABCDEFGHIJ', helper, 'e'.repeat(64))).rejects.toThrow('did not acquire its lock');
        expect(fs.readFileSync(journal, 'utf8')).toBe(originalJournal);
        expect(fs.readFileSync(owner, 'utf8')).toBe('active-owner');
      }
    } finally {
      if (holder && holder.exitCode === null) {
        const exited = new Promise(resolve => holder!.once('exit', resolve));
        holder.stdin!.end(); await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects stale recovery ownership and waits for renderer/utility bundle processes after the main exits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-stale-recovery-test-'));
    try {
      const nonce = randomUUID(), attempt = path.join(root, `attempt-${nonce}`);
      fs.mkdirSync(attempt);
      const helper = path.join(attempt, 'swap-apps');
      expect(spawnSync('/usr/bin/xcrun', ['clang', path.resolve(import.meta.dirname, '../../../../native/personal-update/swap-apps.c'), '-o', helper]).status).toBe(0);
      const journal = { schemaVersion: 1 as const, nonce, phase: 'awaiting-health', identity,
        previousIdentity: { ...identity, revision: 41 }, previousPid: process.pid,
        canonicalApp: '/Applications/Cindy.app', backup: `/Applications/.Cindy-personal-backup-${nonce}.app`,
        health: path.join(root, `health-${nonce}.json`), zip: path.join(root, 'personal-42.zip'),
        sha256: 'c'.repeat(64), helper, helperSha256: 'd'.repeat(64), teamId: 'ABCDEFGHIJ', ownerIdentity: 'e'.repeat(64) };
      const script = path.join(attempt, 'recover.sh'); fs.writeFileSync(script, buildPersonalMacTransaction(journal, root));
      const newer = JSON.stringify({ ...journal, nonce: randomUUID(), phase: 'committed', identity: { ...identity, revision: 43 } });
      fs.writeFileSync(path.join(root, 'transaction.json'), newer);
      const result = spawnSync(helper, ['--lock', path.join(root, 'transaction-process.lock'), script, '--recover']);
      expect(result.status).toBe(75);
      expect(fs.readFileSync(path.join(root, 'transaction.json'), 'utf8')).toBe(newer);
      expect(fs.existsSync(path.join(attempt, 'monitor'))).toBe(false);
      const waitingScript = buildPersonalMacTransaction({ ...journal, previousPid: 2147483647 }, root);
      const waitFunctions = waitingScript.slice(waitingScript.indexOf('bundle_alive() {'), waitingScript.indexOf('phase() {'));
      const fixturePrefix = path.join(root, 'bundle-fixture');
      const renderer = spawn('/bin/bash', ['-c', 'exec -a "$1" /bin/sleep 15', 'fixture', `${fixturePrefix}/Contents/Frameworks/Renderer`]);
      try {
        await expect.poll(() => spawnSync('/usr/bin/pgrep', ['-f', `^${fixturePrefix}/`]).status).toBe(0);
        const wait = () => spawnSync('/bin/bash', [], { encoding: 'utf8', input:
          `set -e\nBUNDLE_PATTERN='^${fixturePrefix}/'\n${waitFunctions}\nsleep() { :; }\nif wait_old_bundle 1; then printf clear; else printf busy; fi\n` });
        expect(wait().stdout).toBe('busy');
        const exited = new Promise(resolve => renderer.once('exit', resolve));
        renderer.kill('SIGKILL'); await exited;
        expect(wait().stdout).toBe('clear');
      } finally { renderer.kill('SIGKILL'); }

    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

});
