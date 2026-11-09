import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { test } from 'vitest';
import { parsePackageArgs } from './ci/package-lib.mjs';
import { appleDevelopmentRequirement, verifyAppleDevelopmentSignature, localCodesignArguments, localDesignatedRequirement, readLocalSigningIdentity, readLocalSigningIdentifier, smokeLocalSignedApp } from './ci/local-mac-signing.mjs';
import { collectMacSigningTargets } from './ci/lib.mjs';

// Unit regression coverage for the opt-in signing boundary. Real certificate,
// signing and TCC continuity are checked separately on the owner's Mac.
test('final local signature smoke runs the existing runner and honors explicit skips', () => {
  const calls = [];
  const smoke = (...args) => calls.push(args);
  const options = { arch: 'arm64', region: 'global', skipSmoke: false, hostCanRunArm64: true };
  smokeLocalSignedApp(options, smoke);
  assert.deepEqual(calls, [['darwin', 'arm64', 'global']]);
  smokeLocalSignedApp({ ...options, skipSmoke: true }, smoke);
  smokeLocalSignedApp({ ...options, hostCanRunArm64: false }, smoke);
  assert.equal(calls.length, 1);
  assert.throws(() => smokeLocalSignedApp(options, () => { throw new Error('final signature cannot launch'); }));
});

test('local signing is explicit, macOS-only and incompatible with no-sign', () => {
  const defaults = { platform: 'darwin', arch: 'arm64' };
  assert.equal(parsePackageArgs([], defaults).localSign, false);
  assert.equal(parsePackageArgs(['--local-sign'], defaults).localSign, true);
  assert.equal(parsePackageArgs(['--no-sign'], defaults).noSign, true);
  assert.throws(() => parsePackageArgs(['--local-sign', '--no-sign'], defaults));
  assert.throws(() => parsePackageArgs(['--local-sign', '--platform', 'linux'], defaults));
  for (const version of ['0.0.0', '1.2.3', 'patch']) {
    assert.throws(() => parsePackageArgs(['--local-sign', '--version', version, '--region', 'global'], defaults),
      /versionless 0\.0\.0/);
  }
});

test('local metadata accepts only a public certificate fingerprint and existing absolute keychain', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-signing-test-'));
  try {
    const metadataPath = path.join(directory, 'identity.json');
    const keychainPath = path.join(directory, 'login.keychain-db');
    fs.writeFileSync(keychainPath, 'unit fixture');
    const value = { schemaVersion: 1, certificateSha1: 'ab'.repeat(20), keychainPath };
    fs.writeFileSync(metadataPath, JSON.stringify(value));
    assert.deepEqual(readLocalSigningIdentity(metadataPath), {
      keychainPath, certificateSha1: 'AB'.repeat(20) });
    const apple = { ...value, signingKind: 'apple-development', teamId: 'TESTTEAM01' };
    fs.writeFileSync(metadataPath, JSON.stringify(apple));
    assert.deepEqual(readLocalSigningIdentity(metadataPath), { keychainPath, signingKind: 'apple-development', teamId: 'TESTTEAM01', certificateSha1: 'AB'.repeat(20) });
    for (const invalid of [{ ...apple, teamId: '' }, { ...apple, teamId: 'spoof' },
      { ...apple, teamId: 1234567890 }, { ...apple, teamId: ['TESTTEAM01'] },
      { ...apple, signingKind: 'unknown' }]) {
      fs.writeFileSync(metadataPath, JSON.stringify(invalid));
      assert.throws(() => readLocalSigningIdentity(metadataPath));
    }
    fs.writeFileSync(metadataPath, JSON.stringify({ ...value, certificateSha1: '-' }));
    assert.throws(() => readLocalSigningIdentity(metadataPath));
    fs.writeFileSync(metadataPath, JSON.stringify({ ...value, keychainPath: 'relative' }));
    assert.throws(() => readLocalSigningIdentity(metadataPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Apple development requirements survive certificate renewal within the verified team', () => {
  const identity = { signingKind: 'apple-development', teamId: 'TESTTEAM01', certificateSha1: 'AB'.repeat(20), keychainPath: '/keychain' };
  const first = localCodesignArguments('com.xd.cindy', identity);
  const renewed = localCodesignArguments('com.xd.cindy', { ...identity, certificateSha1: 'CD'.repeat(20) });
  assert.equal(first.sign[first.sign.indexOf('--sign') + 1], identity.certificateSha1);
  assert.deepEqual(first.verify, renewed.verify);
  assert.ok(first.verify[3].includes('anchor apple generic'));
  assert.ok(first.verify[3].includes('certificate 1[field.1.2.840.113635.100.6.2.1] exists'));
  assert.ok(first.verify[3].includes('certificate leaf[field.1.2.840.113635.100.6.1.12] exists'));
  assert.ok(!first.verify[3].includes(identity.certificateSha1));
  assert.notEqual(appleDevelopmentRequirement('com.xd.cindy', 'TESTTEAM02'), first.verify[3].slice(1));
  assert.throws(() => appleDevelopmentRequirement('com.xd.cindy', 'bad"team'));
  assert.throws(() => appleDevelopmentRequirement('com.xd.cindy', 1234567890));
  assert.throws(() => appleDevelopmentRequirement('com.xd.cindy', ['TESTTEAM01']));
  assert.throws(() => localCodesignArguments('com.xd.cindy', { ...identity, signingKind: 'unknown' }));
});

test('Apple signature verification requires a valid Apple requirement before accepting the observed team', () => {
  const calls = [];
  const verify = (_command, args) => { calls.push(args); return args[0] === '-d' ? 'TeamIdentifier=TESTTEAM01\n' : ''; };
  verifyAppleDevelopmentSignature('/app', 'com.xd.cindy', 'TESTTEAM01', verify);
  assert.equal(calls[0][0], '--verify');
  assert.equal(calls[0][3], '=' + appleDevelopmentRequirement('com.xd.cindy', 'TESTTEAM01'));
  assert.equal(calls[1][0], '-d');
  assert.throws(() => verifyAppleDevelopmentSignature('/app', 'com.xd.cindy', 'TESTTEAM01', () => { throw new Error('Apple requirement failed'); }));
  assert.throws(() => verifyAppleDevelopmentSignature('/app', 'com.xd.cindy', 'TESTTEAM01', (_command, args) => args[0] === '-d' ? 'TeamIdentifier=OTHERTEAM1' : ''));
});

test('designated requirement binds both stable identifier and exact certificate', () => {
  assert.equal(localDesignatedRequirement('com.xd.cindy', 'ab'.repeat(20)),
    `identifier "com.xd.cindy" and certificate leaf = H"${'AB'.repeat(20)}"`);
  assert.throws(() => localDesignatedRequirement('bad"identifier', 'AB'.repeat(20)));
  assert.throws(() => localDesignatedRequirement('com.xd.cindy', '-'));
});

test('codesign receives inline requirements rather than requirement file paths', () => {
  const identity = { certificateSha1: 'AB'.repeat(20), keychainPath: '/Users/test/Library/Keychains/login.keychain-db' };
  const args = localCodesignArguments('com.xd.cindy', identity);
  const requirement = localDesignatedRequirement('com.xd.cindy', identity.certificateSha1);
  assert.equal(args.sign[args.sign.indexOf('--requirements') + 1], `=designated => ${requirement}`);
  assert.deepEqual(args.verify, ['--verify', '--strict', '-R', `=${requirement}`]);
});

// Native helper regression fixtures exercise metadata and traversal only, without
// importing an identity, signing code, launching an app or touching TCC.
test.skipIf(process.platform !== 'darwin')('local bundle IDs come from current metadata and nested signing order stays inside-out', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-signing-layout-'));
  try {
    const appPath = path.join(directory, 'Cindy.app');
    const framework = path.join(appPath, 'Contents', 'Frameworks', 'Fixture.framework');
    const helper = path.join(framework, 'Helpers', 'Fixture Helper.app');
    const executable = path.join(helper, 'Contents', 'MacOS', 'Fixture Helper');
    const plist = identifier => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`;
    for (const [filePath, identifier] of [
      [path.join(appPath, 'Contents', 'Info.plist'), 'com.xd.cindy'],
      [path.join(framework, 'Resources', 'Info.plist'), 'com.xd.cindy.framework'],
      [path.join(helper, 'Contents', 'Info.plist'), 'com.xd.cindy.helper'],
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, plist(identifier));
    }
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    // A minimal Mach-O header is enough for file(1), without compiling or running it.
    fs.writeFileSync(executable, Buffer.from('cffaedfe0c000001000000000200000000000000000000000000000000000000', 'hex'));
    fs.symlinkSync(framework, path.join(framework, 'recursive-link'));
    assert.equal(readLocalSigningIdentifier(appPath, appPath), 'com.xd.cindy');
    assert.equal(readLocalSigningIdentifier(helper, appPath), 'com.xd.cindy.helper');
    assert.equal(readLocalSigningIdentifier(framework, appPath), 'com.xd.cindy.framework');
    assert.deepEqual(collectMacSigningTargets(appPath), [
      { path: executable, helper: false },
      { path: helper, helper: true },
      { path: framework, helper: false },
      { path: appPath, main: true },
    ]);
    const rawIdentifier = readLocalSigningIdentifier(executable, appPath);
    const otherApp = path.join(directory, 'Other Copy.app');
    fs.renameSync(appPath, otherApp);
    assert.equal(readLocalSigningIdentifier(path.join(otherApp, path.relative(appPath, executable)), otherApp), rawIdentifier);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
