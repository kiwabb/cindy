import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { validatePersonalManifest, validatePersonalPolicy, validatePersonalIdentity } from '../contract.mjs';
import { handlePersonalRendererReadiness } from '../readiness';
import { validPersonalSmokeReceipt } from '../prepareProcess';
import { validateUpdateZip } from '../archive';
import { acknowledgePersonalStorageReady, writeAtomicJson, buildPersonalMacTransaction, resumePersonalTransactionSafely } from '../transaction';

const policy = validatePersonalPolicy({ schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64',
  feedUrl: 'https://github.com/kiwabb/cindy/releases/download/personal-macos-arm64/personal-update.json', storageCompatibilityVersion: 1 });
const identity = validatePersonalIdentity({ schemaVersion: 1, repository: policy.repository, channel: policy.channel,
  revision: 42, sourceCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', region: 'global',
  bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64) }, policy);
const manifest = { ...identity, asset: { url: 'https://github.com/kiwabb/cindy/releases/download/personal-macos-arm64-r42/app.zip', sha256: 'c'.repeat(64), size: 100 } };

describe('personal update trust boundary', () => {
  it('accepts only the fixed source, matching immutable revision and known storage identity', () => {
    expect(validatePersonalManifest(manifest, policy)).toEqual(manifest);
    for (const url of [manifest.asset.url.replace('kiwabb', 'attacker'), manifest.asset.url.replace('r42', 'r41'),
      manifest.asset.url.replace('github.com', 'github.com.evil.example'), manifest.asset.url + '?download=1']) {
      expect(() => validatePersonalManifest({ ...manifest, asset: { ...manifest.asset, url } }, policy)).toThrow();
    }
    expect(() => validatePersonalManifest({ ...manifest, revision: 0 }, policy)).toThrow();
    expect(() => validatePersonalManifest({ ...manifest, storageIdentity: '' }, policy)).toThrow();
  });

  it.skipIf(process.platform !== 'darwin')('durably acknowledges only the exact canonical revision, nonce and opened-storage transaction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-health-test-'));
    try {
      const nonce = randomUUID(), health = path.join(root, `health-${nonce}.json`);
      writeAtomicJson(path.join(root, 'transaction.json'), { schemaVersion: 1, nonce, phase: 'awaiting-health',
        canonicalApp: '/Applications/Cindy.app', health, identity, ownerIdentity: 'e'.repeat(64) });
      expect(acknowledgePersonalStorageReady(root, '/elsewhere/Cindy.app', identity, 'e'.repeat(64), '1:2')).toBe(false);
      expect(acknowledgePersonalStorageReady(root, '/Applications/Cindy.app', { ...identity, revision: 41 }, 'e'.repeat(64), '1:2')).toBe(false);
      expect(acknowledgePersonalStorageReady(root, '/Applications/Cindy.app', { ...identity, storageIdentity: 'f'.repeat(64) }, 'e'.repeat(64), '1:2')).toBe(false);
      expect(acknowledgePersonalStorageReady(root, '/Applications/Cindy.app', identity, 'f'.repeat(64), '1:2')).toBe(false);
      expect(fs.existsSync(health)).toBe(false);
      expect(acknowledgePersonalStorageReady(root, '/Applications/Cindy.app', identity, 'e'.repeat(64), '1:2', 123)).toBe(true);
      expect(JSON.parse(fs.readFileSync(health, 'utf8'))).toMatchObject({ nonce, revision: 42, storageOpened: true, pid: 123 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

function zipEntry(name: string, target = 'content', symlink = false, localName = name): Buffer {
  const bytes = Buffer.from(target), encoded = Buffer.from(name), localEncoded = Buffer.from(localName);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(localEncoded.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(((symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
  const offset = local.length + localEncoded.length + bytes.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + encoded.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, localEncoded, bytes, central, encoded, end]);
}

describe('personal update archive preflight', () => {
  it.each([
    ['Cindy.app/file', 'content', false, 'Cindy.app/file', true],
    ['Cindy.app/Framework/Current', 'A', true, 'Cindy.app/Framework/Current', true],
    ['Cindy.app/../outside', 'content', false, 'Cindy.app/../outside', false],
    ['Cindy.app/link', '../../outside', true, 'Cindy.app/link', false],
    ['Cindy.app/file', 'content', false, '../../outside', false],
  ] as const)('checks archive path %s before extraction', (name, value, symlink, localName, allowed) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-zip-test-'));
    const archive = path.join(root, 'update.zip');
    try {
      fs.writeFileSync(archive, zipEntry(name, value, symlink, localName));
      if (allowed) expect(() => validateUpdateZip(archive)).not.toThrow();
      else expect(() => validateUpdateZip(archive)).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


function transactionFixture(root: string) {
  const nonce = randomUUID();
  const journal = {
    schemaVersion: 1 as const,
    nonce,
    phase: 'prepared',
    identity,
    previousIdentity: { ...identity, revision: 41 },
    previousPid: 123,
    canonicalApp: '/Applications/Cindy.app',
    backup: `/Applications/.Cindy-personal-backup-${nonce}.app`,
    health: path.join(root, `health-${nonce}.json`),
    zip: path.join(root, 'personal-42.zip'),
    sha256: 'c'.repeat(64),
    helper: path.join(root, `attempt-${nonce}`, 'swap-apps'),
    helperSha256: 'd'.repeat(64),
    teamId: 'ABCDEFGHIJ',
    ownerIdentity: 'e'.repeat(64),
  };
  return journal;
}

describe('personal update transaction script', () => {
  it('rejects a substituted canonical or backup path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-script-test-'));
    try {
      const journal = transactionFixture(root);
      expect(() => buildPersonalMacTransaction({ ...journal, canonicalApp: '/tmp/Cindy.app' }, root)).toThrow();
      expect(() => buildPersonalMacTransaction({ ...journal, backup: '/Applications/Other.app' }, root)).toThrow();
      expect(() => buildPersonalMacTransaction({ ...journal, helper: '/tmp/untrusted-helper' }, root)).toThrow();
      expect(() => buildPersonalMacTransaction({ ...journal, phase: 'future-unknown-phase' }, root)).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'darwin')('validates the macOS transaction syntax with system Bash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-script-syntax-test-'));
    try {
      const script = buildPersonalMacTransaction(transactionFixture(root), root);
      const parsed = spawnSync('/bin/bash', ['-n'], { input: script, encoding: 'utf8' });
      expect(parsed.status, parsed.stderr).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'darwin')('executes the macOS health predicate against stale and valid receipts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-health-predicate-test-'));
    try {
      const journal = transactionFixture(root);
      const { nonce } = journal;
      const script = buildPersonalMacTransaction(journal, root);
      // Execute the emitted health predicate with filesystem/process fixtures only.
      // The signature boundary is stubbed here; no installed application is inspected.
      const begin = script.indexOf('valid_health() {');
      const end = script.indexOf('for i in $(seq 1 180); do', begin);
      const predicate = script.slice(begin, end);
      fs.mkdirSync(path.dirname(journal.helper), { recursive: true });
      fs.writeFileSync(journal.helper, '#!/bin/sh\nprintf 1:2\n', { mode: 0o700 });
      const receipt = { nonce, revision: 42, storageIdentity: identity.storageIdentity,
        canonicalApp: journal.canonicalApp, storageOpened: true, coreReady: true,
        ownerIdentity: journal.ownerIdentity, pid: process.pid, processBirth: '1:2' };
      const check = (value: object) => {
        fs.writeFileSync(journal.health, JSON.stringify(value));
        return spawnSync('/bin/bash', [], { encoding: 'utf8', input: `set -e\nHEALTH='${journal.health}'\nAPP='${journal.canonicalApp}'\nHELPER='${journal.helper}'\nmatches() { return 0; }\n${predicate}\nif valid_health; then printf ready; else printf waiting; fi\n` });
      };
      expect(check({ ...receipt, pid: 2147483647 }).stdout).toBe('waiting');
      expect(check({ ...receipt, processBirth: '1:3' }).stdout).toBe('waiting');
      expect(check({ ...receipt, ownerIdentity: 'f'.repeat(64) }).stdout).toBe('waiting');
      expect(check(receipt).stdout).toBe('ready');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


describe('personal update recovery and real smoke receipt validation', () => {
  it.each(['{"schemaVersion":', JSON.stringify({ schemaVersion: 1, phase: 'unknown-phase' })])('blocks updates without throwing or discarding a malformed journal', contents => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-recovery-test-'));
    try {
      fs.writeFileSync(path.join(root, 'transaction.json'), contents);
      expect(resumePersonalTransactionSafely(root, '/Applications/Cindy.app', identity)).toBe(false);
      expect(fs.readFileSync(path.join(root, 'transaction.json'), 'utf8')).toBe(contents);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'recovery-blocked.json'), 'utf8')).code).toBe('PERSONAL_UPDATE_RECOVERY_REQUIRES_REVIEW');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('requires official core table counts and a genuinely empty smoke owner', () => {
    const receipt = { ok: true, schema_version: 1, tables: { sessions: 0, messages: 0, migration_meta: 1 } };
    expect(validPersonalSmokeReceipt(receipt)).toBe(true);
    for (const invalid of [{ ok: true, schema_version: 1 }, { ...receipt, schema_version: -1 },
      { ...receipt, tables: { ...receipt.tables, sessions: 1 } },
      { ...receipt, tables: { ...receipt.tables, messages: 1 } },
      { ...receipt, tables: { ...receipt.tables, migration_meta: -1 } },
      { ...receipt, tables: { ...receipt.tables, migration_meta: NaN } }]) {
      expect(validPersonalSmokeReceipt(invalid)).toBe(false);
    }
  });
});


describe('existing app readiness IPC personal extension', () => {
  it('leaves legacy calls untouched and accepts only committed main-frame authenticated signals', () => {
    const acknowledge = vi.fn();
    const session = { dataOwnerId: 'fixture-owner', mode: 'cloud', generation: 1 };
    const committed = { rendererCommitted: true, dataOwnerId: 'fixture-owner', ownerGeneration: 1 };
    expect(handlePersonalRendererReadiness(undefined, false, session, acknowledge)).toBe(false);
    expect(acknowledge).not.toHaveBeenCalled();
    for (const options of [null, {}, { rendererCommitted: false }, { rendererCommitted: true, extra: true }]) {
      expect(() => handlePersonalRendererReadiness(options, true, session, acknowledge)).toThrow();
    }
    expect(() => handlePersonalRendererReadiness(committed, false, session, acknowledge)).toThrow();
    expect(() => handlePersonalRendererReadiness(committed, true, { dataOwnerId: null, mode: 'signed-out', generation: 2 }, acknowledge)).toThrow('Stale');
    expect(() => handlePersonalRendererReadiness(committed, true, { ...session, generation: 2 }, acknowledge)).toThrow('Stale');
    expect(() => handlePersonalRendererReadiness(committed, true, { ...session, dataOwnerId: 'other-owner' }, acknowledge)).toThrow('Stale');
    expect(acknowledge).not.toHaveBeenCalled();
    expect(handlePersonalRendererReadiness(committed, true, session, acknowledge)).toBe(true);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith('fixture-owner', 'cloud', 1);
  });
});
