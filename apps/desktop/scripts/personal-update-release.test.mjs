/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPersonalUpdateIdentity, computeStorageIdentity, personalRevisionForRun, parsePersonalRevision } from './ci/personal-update-metadata.mjs';
import { assertPackagedPersonalIdentity, createPersonalUpdateManifest, hashFile } from './ci/personal-update-artifacts.mjs';
import { assertChannelAdvance, assertPublicationContext, publishPersonalUpdate } from './publish-personal-update.mjs';

const policy = { schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64',
  feedUrl: 'https://github.com/kiwabb/cindy/releases/download/personal-macos-arm64/personal-update.json', storageCompatibilityVersion: 1 };
const sourceCommit = 'a'.repeat(40);
const identity = { schemaVersion: 1, repository: policy.repository, channel: policy.channel, revision: 12301,
  sourceCommit, platform: 'darwin', arch: 'arm64', region: 'global', bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64) };
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: policy.repository, GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sourceCommit, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const desktopRoot = path.join(dir, 'repo', 'apps', 'desktop');
  const artifactDir = path.join(dir, 'artifacts');
  fs.mkdirSync(artifactDir); fs.mkdirSync(desktopRoot, { recursive: true });
  fs.writeFileSync(path.join(desktopRoot, 'personal-update-channel.json'), JSON.stringify(policy));
  // Explicit unit fixture bytes. No app, database, account, keychain or model is started.
  const zip = 'cindy-unversioned-arm64.zip';
  fs.writeFileSync(path.join(artifactDir, zip), 'unit ZIP integrity bytes');
  const info = { personalUpdate: identity, commitSha: sourceCommit, platform: 'darwin', arch: 'arm64', region: 'global',
    versionless: true, files: [{ name: zip, size: fs.statSync(path.join(artifactDir, zip)).size, sha256: hashFile(path.join(artifactDir, zip)) }] };
  const manifest = createPersonalUpdateManifest({ buildInfo: info, artifactDir, policy });
  fs.writeFileSync(path.join(artifactDir, 'build-info.json'), JSON.stringify(info));
  fs.writeFileSync(path.join(artifactDir, 'personal-update.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(artifactDir, 'cindy-unversioned-arm64.dmg'), 'unit DMG bytes');
  fs.writeFileSync(path.join(artifactDir, 'SHA256SUMS'), 'unit checksums');
  return { dir, desktopRoot, artifactDir, info, manifest };
}
function fakeGitHub({ current, failApi, beforePublish, badImmutable = false, tagCommit = sourceCommit,
  annotatedTag = false, keepDraft = false, failFeedUploadOnce = false } = {}) {
  const releases = new Map(); const events = [];
  if (current) releases.set(policy.channel, { target_commitish: current.sourceCommit, draft: false, body: '', assets: [asset('personal-update.json', Buffer.from(JSON.stringify(current)))] });
  function asset(name, bytes) { return { name, bytes, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }; }
  function runGh(args) {
    events.push(args);
    if (args[0] === 'api') {
      if (failApi) throw Object.assign(new Error('HTTP 403'), { stderr: 'HTTP 403' });
      if (args[1].endsWith('branches/main')) return JSON.stringify({ commit: { sha: sourceCommit } });
      if (args[1].includes('/git/ref/tags/')) return JSON.stringify({ object: {
        type: annotatedTag ? 'tag' : 'commit', sha: annotatedTag ? 'd'.repeat(40) : tagCommit,
      } });
      if (args[1].includes('/git/tags/')) return JSON.stringify({ object: { type: 'commit', sha: tagCommit } });
      const tag = args[1].split('/').at(-1); const release = releases.get(tag);
      if (!release) throw Object.assign(new Error('HTTP 404'), { stderr: 'HTTP 404' });
      return JSON.stringify(release);
    }
    const [, command, tag] = args;
    const value = flag => args[args.indexOf(flag) + 1];
    if (command === 'create') releases.set(tag, { target_commitish: value('--target'), draft: args.includes('--draft'), assets: [], body: value('--notes') });
    if (command === 'upload') {
      const file = args[3]; const r = releases.get(tag); const name = path.basename(file);
      if (r.assets.some(item => item.name === name)) assert.ok(args.includes('--clobber'));
      r.assets = r.assets.filter(item => item.name !== name);
      if (tag === policy.channel && failFeedUploadOnce) {
        failFeedUploadOnce = false;
        throw new Error('Feed upload failed after deleting the previous asset');
      }
      r.assets.push(asset(name, fs.readFileSync(file)));
      if (badImmutable && tag !== policy.channel) r.assets.at(-1).digest = `sha256:${'0'.repeat(64)}`;
    }
    if (command === 'download') {
      const item = releases.get(tag).assets.find(a => a.name === value('--pattern'));
      fs.writeFileSync(path.join(value('--dir'), item.name), Buffer.from(item.bytes));
    }
    if (command === 'edit') {
      const r = releases.get(tag);
      if (args.includes('--draft=false')) { r.draft = keepDraft; beforePublish?.(releases, asset); }
      if (args.includes('--notes')) r.body = value('--notes');
    }
    return '';
  }
  return { runGh, events, releases };
}

test('run and attempt revisions are safe, ordered and reject ambiguous numbers', () => {
  assert.equal(personalRevisionForRun('123', '1'), 12301);
  assert.ok(personalRevisionForRun('124', '1') > personalRevisionForRun('123', '99'));
  for (const bad of ['0', '-1', '1.5', '01', '9007199254740992', '']) assert.throws(() => parsePersonalRevision(bad));
  assert.throws(() => personalRevisionForRun('123', '100'));
  assert.throws(() => personalRevisionForRun('9007199254740991', '1'));
});

test('storage identity covers SQL, companion, schema, personal JSON persistence and explicit compatibility', t => {
  const { desktopRoot } = fixture(t);
  const storageFiles = ['drizzle/0000_init.sql', 'drizzle/meta/_journal.json', 'drizzle/scripts/0000_init.ts',
    'src/main/localDb/schema.ts', 'src/main/maker-ipc/personalTodoStore.ts',
    'src/main/maker-ipc/botTodoStore.ts', '../../packages/maker-shared/src/teammateTodo.ts'];
  for (const name of storageFiles) {
    fs.mkdirSync(path.dirname(path.join(desktopRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(desktopRoot, name), 'unit bytes');
  }
  const first = computeStorageIdentity(desktopRoot, policy);
  fs.writeFileSync(path.join(desktopRoot, 'drizzle/meta/0000_snapshot.json'), 'pruned build input');
  assert.equal(computeStorageIdentity(desktopRoot, policy), first);
  for (const name of storageFiles) {
    fs.appendFileSync(path.join(desktopRoot, name), 'changed');
    assert.notEqual(computeStorageIdentity(desktopRoot, policy), first);
    fs.writeFileSync(path.join(desktopRoot, name), 'unit bytes');
  }
  assert.notEqual(computeStorageIdentity(desktopRoot, { ...policy, storageCompatibilityVersion: 2 }), first);
  fs.symlinkSync('/tmp', path.join(desktopRoot, 'drizzle/unsafe'));
  assert.throws(() => computeStorageIdentity(desktopRoot, policy), /symlink/);
});

test('ordinary packages do not gain a personal update identity', () => {
  assert.equal(buildPersonalUpdateIdentity({ desktopRoot: '/missing', sourceCommit, revision: '' }), null);
});

test('ZIP integrity, platform/source and embedded metadata must all agree', t => {
  const { artifactDir, info, manifest } = fixture(t);
  assert.deepEqual(assertPackagedPersonalIdentity({ sourceCommit, personalUpdate: identity }, manifest, policy), identity);
  assert.throws(() => assertPackagedPersonalIdentity({ sourceCommit, personalUpdate: { ...identity, revision: 4 } }, manifest, policy));
  assert.throws(() => createPersonalUpdateManifest({ buildInfo: { ...info, arch: 'x64' }, artifactDir, policy }));
  assert.throws(() => createPersonalUpdateManifest({ buildInfo: { ...info, files: [{ ...info.files[0], name: 'other.zip' }] }, artifactDir, policy }), /personal Mac packaged ZIP/);
  fs.appendFileSync(path.join(artifactDir, info.files[0].name), 'corruption');
  assert.throws(() => createPersonalUpdateManifest({ buildInfo: info, artifactDir, policy }), /integrity/);
});

test('publisher is restricted to the exact fork/main/SHA/run identity', t => {
  const { manifest } = fixture(t);
  assertPublicationContext(manifest, environment);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY: 'other/cindy', GITHUB_REF: 'refs/heads/feature', GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ATTEMPT: '2' })) {
    assert.throws(() => assertPublicationContext(manifest, { ...environment, [key]: value }));
  }
});

test('channel rejects downgrade and equal-revision replacement', t => {
  const { manifest } = fixture(t);
  assertChannelAdvance(manifest, manifest);
  assert.throws(() => assertChannelAdvance({ ...manifest, revision: manifest.revision + 1 }, manifest), /downgrade/);
  assert.throws(() => assertChannelAdvance({ ...manifest, sourceCommit: 'c'.repeat(40) }, manifest), /different bytes/);
});

test('publication verifies immutable bytes before advancing feed and safely retries', t => {
  const setup = fixture(t); const fake = fakeGitHub();
  const options = { ...setup, env: environment, runGh: fake.runGh };
  assert.deepEqual(publishPersonalUpdate(options), setup.manifest);
  const publicIndex = fake.events.findIndex(args => args[1] === 'edit' && args.includes('--draft=false'));
  const feedIndex = fake.events.findIndex(args => args[1] === 'upload' && args[2] === policy.channel);
  assert.ok(publicIndex >= 0 && feedIndex > publicIndex);
  assert.deepEqual(publishPersonalUpdate(options), setup.manifest);
  assert.equal(fake.events.filter(args => args[1] === 'upload' && args[2] === policy.channel).length, 1);
});

test('remote integrity failure never publishes the feed', t => {
  const setup = fixture(t); const fake = fakeGitHub({ badImmutable: true });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: fake.runGh }), /hash mismatch/);
  assert.equal(fake.releases.has(policy.channel), false);
});

test('a newer channel appearing during publication blocks the stale candidate', t => {
  const setup = fixture(t);
  const fake = fakeGitHub({ beforePublish(releases, asset) {
    const newer = { ...setup.manifest, revision: setup.manifest.revision + 1,
      asset: { ...setup.manifest.asset, url: setup.manifest.asset.url.replace('-r12301/', '-r12302/') } };
    releases.set(policy.channel, { assets: [asset('personal-update.json', Buffer.from(JSON.stringify(newer)))] });
  } });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: fake.runGh }), /downgrade/);
  assert.equal(fake.events.some(args => args[1] === 'upload' && args[2] === policy.channel), false);
});

test('GitHub authentication failures do not bootstrap an empty channel', t => {
  const setup = fixture(t); const fake = fakeGitHub({ failApi: true });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: fake.runGh }), /403/);
  assert.equal(fake.events.some(args => args[0] === 'release'), false);
});

test('a failed feed replacement retains its floor and can repair the same immutable revision', t => {
  const setup = fixture(t);
  const previous = { ...setup.manifest, revision: 12201,
    asset: { ...setup.manifest.asset, url: setup.manifest.asset.url.replace('-r12301/', '-r12201/') } };
  const fake = fakeGitHub({ current: previous, failFeedUploadOnce: true });
  const options = { ...setup, env: environment, runGh: fake.runGh };
  assert.throws(() => publishPersonalUpdate(options), /Feed upload failed/);
  const channel = fake.releases.get(policy.channel);
  assert.match(channel.body, /Personal update revision 12301/);
  assert.equal(channel.assets.length, 0);
  assert.deepEqual(publishPersonalUpdate(options), setup.manifest);
});

test('a missing feed asset never permits a downgrade below the durable channel floor', t => {
  const setup = fixture(t);
  const fake = fakeGitHub({ failFeedUploadOnce: true });
  const options = { ...setup, env: environment, runGh: fake.runGh };
  assert.throws(() => publishPersonalUpdate(options), /Feed upload failed/);
  fake.releases.get(policy.channel).body = 'Personal update revision 12302';
  assert.throws(() => publishPersonalUpdate(options), /downgrade/);
});

test('publication verifies the actual tag commit and resolves annotated tags', t => {
  const setup = fixture(t);
  const wrong = fakeGitHub({ tagCommit: 'c'.repeat(40) });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: wrong.runGh }), /tag points to another source/);
  assert.equal(wrong.releases.has(policy.channel), false);
  const annotated = fakeGitHub({ annotatedTag: true });
  assert.deepEqual(publishPersonalUpdate({ ...setup, env: environment, runGh: annotated.runGh }), setup.manifest);
});

test('a release that remains a draft cannot become the channel target', t => {
  const setup = fixture(t); const fake = fakeGitHub({ keepDraft: true });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: fake.runGh }), /still a draft/);
  assert.equal(fake.releases.has(policy.channel), false);
});

test('a revision floor must be observed before deleting the current feed asset', t => {
  const setup = fixture(t);
  const previous = { ...setup.manifest, revision: 12201,
    asset: { ...setup.manifest.asset, url: setup.manifest.asset.url.replace('-r12301/', '-r12201/') } };
  const fake = fakeGitHub({ current: previous });
  const runGh = args => args[1] === 'edit' && args[2] === policy.channel ? '' : fake.runGh(args);
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh }), /floor was not persisted/);
  assert.equal(fake.events.some(args => args[1] === 'upload' && args[2] === policy.channel), false);
});

test('an interrupted immutable draft upload resumes without overwriting existing assets', t => {
  const setup = fixture(t); const fake = fakeGitHub();
  let fail = true;
  const runGh = args => {
    if (fail && args[1] === 'upload' && args[3].endsWith('.dmg')) {
      fail = false;
      throw new Error('Interrupted draft upload');
    }
    return fake.runGh(args);
  };
  const options = { ...setup, env: environment, runGh };
  assert.throws(() => publishPersonalUpdate(options), /Interrupted draft upload/);
  const immutable = fake.releases.get(`${policy.channel}-r${identity.revision}`);
  assert.equal(immutable.draft, true);
  assert.equal(immutable.assets.length, 1);
  assert.deepEqual(publishPersonalUpdate(options), setup.manifest);
  assert.equal(fake.events.filter(args => args[1] === 'upload' && args[3].endsWith('.zip')).length, 1);
});
