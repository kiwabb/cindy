/* global Buffer */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import JSZip from 'jszip';
import { assertPersonalUpdateBuildSource, buildPersonalUpdateIdentity, computeStorageIdentity, personalRevisionForRun, parsePersonalRevision } from './ci/personal-update-metadata.mjs';
import { assertPackagedPersonalIdentity, createPersonalUpdateManifest, hashFile } from './ci/personal-update-artifacts.mjs';
import { preparePersonalUpdate } from './prepare-personal-update.mjs';
import { assertChannelAdvance, assertPublicationContext, publishPersonalUpdate } from './publish-personal-update.mjs';

const policy = { schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64',
  feedUrl: 'https://github.com/kiwabb/cindy/releases/download/personal-macos-arm64/personal-update.json', storageCompatibilityVersion: 1 };
const channelFile = { schemaVersion: 2, repository: policy.repository, storageCompatibilityVersion: 1,
  channels: { 'darwin-arm64': 'personal-macos-arm64', 'win32-x64': 'personal-windows-x64' } };
const sourceCommit = 'a'.repeat(40);
const identity = { schemaVersion: 1, repository: policy.repository, channel: policy.channel, revision: 12301,
  sourceCommit, platform: 'darwin', arch: 'arm64', region: 'global', bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64) };
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: policy.repository, GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sourceCommit, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-release-test-'));
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const desktopRoot = path.join(dir, 'repo', 'apps', 'desktop');
  const artifactDir = path.join(dir, 'artifacts');
  fs.mkdirSync(artifactDir); fs.mkdirSync(desktopRoot, { recursive: true });
  fs.writeFileSync(path.join(desktopRoot, 'personal-update-channel.json'), JSON.stringify(channelFile));
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
  let nextId = 1;
  if (current) releases.set(policy.channel, { id: nextId++, tag_name: policy.channel, target_commitish: current.sourceCommit, draft: false, body: '', assets: [asset('personal-update.json', Buffer.from(JSON.stringify(current)))] });
  function asset(name, bytes) { return { name, bytes, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }; }
  function runGh(args) {
    events.push(args);
    if (args[0] === 'api') {
      if (failApi) throw Object.assign(new Error('HTTP 403'), { stderr: 'HTTP 403' });
      if (args[1].endsWith('branches/main')) return JSON.stringify({ commit: { sha: sourceCommit } });
      if (args.includes('POST')) {
        const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
        const value = { ...body, id: nextId++, assets: [] };
        releases.set(body.tag_name, value);
        return JSON.stringify(value);
      }
      if (args[1].includes('/git/ref/tags/')) {
        const value = releases.get(args[1].split('/').at(-1));
        if (!value || value.draft) throw Object.assign(new Error('HTTP 404'), { stderr: 'HTTP 404' });
        return JSON.stringify({ object: { type: annotatedTag ? 'tag' : 'commit', sha: annotatedTag ? 'd'.repeat(40) : tagCommit } });
      }
      if (args[1].includes('/git/tags/')) return JSON.stringify({ object: { type: 'commit', sha: tagCommit } });
      if (args[1].includes('/releases?')) {
        const query = new URL(`https://api.github.test/${args[1]}`).searchParams;
        const page = Number(query.get('page'));
        return JSON.stringify([...releases.values()].slice((page - 1) * 100, page * 100));
      }
      const key = args[1].split('/').at(-1);
      const byTag = args[1].includes('/releases/tags/');
      const value = byTag ? releases.get(key) : [...releases.values()].find(item => item.id === Number(key));
      if (!value || (byTag && value.draft)) throw Object.assign(new Error('HTTP 404'), { stderr: 'HTTP 404' });
      return JSON.stringify(value);
    }
    const [, command, tag] = args;
    const value = flag => args[args.indexOf(flag) + 1];
    if (command === 'create') releases.set(tag, { id: nextId++, tag_name: tag, target_commitish: value('--target'), draft: args.includes('--draft'), assets: [], body: value('--notes') });
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

test('display build time is an optional feed field that the verified-ZIP check ignores', t => {
  const setup = fixture(t);
  const withTime = { ...setup.manifest, builtAt: '2026-11-11T00:53:59.613+00:00' };
  const feed = path.join(setup.artifactDir, 'personal-update.json');
  fs.writeFileSync(feed, JSON.stringify(withTime));
  const options = { ...setup, env: environment, runGh: fakeGitHub().runGh };
  assert.deepEqual(publishPersonalUpdate(options), withTime);
  // A different identity is still rejected even when builtAt is present.
  fs.writeFileSync(feed, JSON.stringify({ ...withTime, sourceCommit: 'c'.repeat(40) }));
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: fakeGitHub().runGh }), /does not describe the verified ZIP/);
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
    releases.set(policy.channel, { id: 1000, tag_name: policy.channel, target_commitish: sourceCommit, draft: false, assets: [asset('personal-update.json', Buffer.from(JSON.stringify(newer)))] });
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

test('new drafts use the POST release ID while tag lookup and git refs remain unpublished', t => {
  const setup = fixture(t);
  const fake = fakeGitHub();
  assert.deepEqual(publishPersonalUpdate({ ...setup, env: environment, runGh: fake.runGh }), setup.manifest);
  const created = fake.events.findIndex(args => args[0] === 'api' && args.includes('POST'));
  assert.ok(created >= 0);
  assert.equal(fake.events[created + 1][1], `repos/${policy.repository}/releases/1`);
  const published = fake.events.findIndex(args => args[1] === 'edit' && args.includes('--draft=false'));
  const checkedTag = fake.events.findIndex(args => args[1].includes('/git/ref/tags/'));
  assert.ok(checkedTag > published);
});

test('draft recovery searches every page for the exact tag and refreshes its ID', t => {
  const setup = fixture(t);
  const fake = fakeGitHub();
  for (let index = 0; index < 100; index++) {
    const name = `unrelated-${index}`;
    fake.releases.set(name, { id: index + 100, tag_name: name, draft: true, assets: [] });
  }
  const tag = `${policy.channel}-r${identity.revision}`;
  fake.releases.set(tag, { id: 500, tag_name: tag, target_commitish: sourceCommit, draft: true, assets: [] });
  assert.deepEqual(publishPersonalUpdate({ ...setup, env: environment, runGh: fake.runGh }), setup.manifest);
  assert.ok(fake.events.some(args => args[1].endsWith('releases?per_page=100&page=2')));
  assert.ok(fake.events.some(args => args[1].endsWith('/releases/500')));
  assert.equal(fake.events.some(args => args[0] === 'api' && args.includes('POST')), false);
});

test('ambiguous drafts and a draft with another source cannot be chosen for recovery', t => {
  const setup = fixture(t);
  const tag = `${policy.channel}-r${identity.revision}`;
  const ambiguous = fakeGitHub();
  for (const id of [501, 502]) {
    ambiguous.releases.set(`draft-${id}`, { id, tag_name: tag, target_commitish: sourceCommit, draft: true, assets: [] });
  }
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: ambiguous.runGh }), /Ambiguous releases/);
  assert.equal(ambiguous.events.some(args => args[0] === 'release'), false);
  const wrongSource = fakeGitHub();
  wrongSource.releases.set(tag, { id: 503, tag_name: tag, target_commitish: 'c'.repeat(40), draft: true, assets: [] });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: wrongSource.runGh }), /another source/);
  assert.equal(wrongSource.events.some(args => args[0] === 'release'), false);
  const missingId = fakeGitHub();
  missingId.releases.set(tag, { tag_name: tag, target_commitish: sourceCommit, draft: true, assets: [] });
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh: missingId.runGh }), /Invalid release ID/);
  assert.equal(missingId.events.some(args => args.includes('POST')), false);
});

test('an ID refresh cannot substitute another release tag', t => {
  const setup = fixture(t);
  const fake = fakeGitHub();
  const runGh = args => {
    const output = fake.runGh(args);
    if (args[0] === 'api' && args[1].endsWith('/releases/1')) {
      return JSON.stringify({ ...JSON.parse(output), tag_name: 'another-tag' });
    }
    return output;
  };
  assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh }), /expected tag/);
  assert.equal(fake.events.some(args => args[1] === 'upload'), false);
});

test('an explicit duplicate-tag POST conflict can resume only the exact existing release', t => {
  const setup = fixture(t);
  const fake = fakeGitHub();
  const tag = `${policy.channel}-r${identity.revision}`;
  const runGh = args => {
    if (args[0] === 'api' && args.includes('POST')) {
      fake.releases.set(tag, { id: 600, tag_name: tag, target_commitish: sourceCommit, draft: true, assets: [] });
      throw Object.assign(new Error('HTTP 422'), { stderr: 'HTTP 422', stdout: JSON.stringify({
        errors: [{ resource: 'Release', field: 'tag_name', code: 'already_exists' }],
      }) });
    }
    return fake.runGh(args);
  };
  assert.deepEqual(publishPersonalUpdate({ ...setup, env: environment, runGh }), setup.manifest);
});

for (const failure of ['HTTP 403', 'HTTP 500', 'HTTP 409', 'HTTP 422', 'connection reset']) {
  test(`creation failure ${failure} cannot be masked by an unrelated or newly visible draft`, t => {
    const setup = fixture(t);
    const fake = fakeGitHub();
    const tag = `${policy.channel}-r${identity.revision}`;
    const runGh = args => {
      if (args[0] === 'api' && args.includes('POST')) {
        fake.releases.set(tag, { id: 700, tag_name: tag, target_commitish: sourceCommit, draft: true, assets: [] });
        throw Object.assign(new Error(failure), { stderr: failure, stdout: JSON.stringify({
          errors: [{ resource: 'Release', field: 'name', code: 'invalid' }],
        }) });
      }
      return fake.runGh(args);
    };
    assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh }), new RegExp(failure));
    assert.equal(fake.events.some(args => args[1] === 'upload'), false);
  });
}


test('invalid release metadata cannot bypass draft, asset or source checks', t => {
  const variants = [
    ['missing draft', value => ({ ...value, draft: undefined })],
    ['nonboolean draft', value => ({ ...value, draft: 'false' })],
    ['nonarray assets', value => ({ ...value, assets: {} })],
    ['missing source', value => ({ ...value, target_commitish: undefined })],
    ['null response', () => null],
    ['array response', () => []],
  ];
  for (const [name, change] of variants) {
    const setup = fixture(t);
    const fake = fakeGitHub();
    const runGh = args => {
      const output = fake.runGh(args);
      return args[0] === 'api' && args[1].endsWith('/releases/1')
        ? JSON.stringify(change(JSON.parse(output))) : output;
    };
    assert.throws(() => publishPersonalUpdate({ ...setup, env: environment, runGh }), /Invalid release metadata/, name);
    assert.equal(fake.events.some(args => args[1] === 'upload'), false, name);
    assert.equal(fake.releases.has(policy.channel), false, name);
  }
});

test('Windows channel builds its own identity, ZIP name and tag, and reads backslash ZIP entries', async t => {
  const { desktopRoot, artifactDir } = fixture(t);
  for (const name of ['drizzle/0000_init.sql', 'drizzle/meta/_journal.json', 'src/main/localDb/schema.ts',
    'src/main/maker-ipc/personalTodoStore.ts', 'src/main/maker-ipc/botTodoStore.ts', '../../packages/maker-shared/src/teammateTodo.ts']) {
    fs.mkdirSync(path.dirname(path.join(desktopRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(desktopRoot, name), 'unit bytes');
  }
  const winIdentity = buildPersonalUpdateIdentity({ desktopRoot, sourceCommit, platform: 'win32', arch: 'x64', revision: '12301' });
  assert.deepEqual([winIdentity.channel, winIdentity.platform, winIdentity.arch], ['personal-windows-x64', 'win32', 'x64']);
  assert.equal(winIdentity.storageIdentity, buildPersonalUpdateIdentity({ desktopRoot, sourceCommit, platform: 'darwin', arch: 'arm64', revision: '1' }).storageIdentity);
  assert.throws(() => assertPersonalUpdateBuildSource({ desktopRoot, sourceCommit, platform: 'win32', archs: ['arm64'], region: 'global' }), /win32-x64/);

  const zip = new JSZip();
  // PowerShell 5.1 Compress-Archive stores backslash separators.
  zip.file('resources\\cindy-source.json', JSON.stringify({ sourceCommit, builtAt: '2026-11-11T00:53:59.613+00:00', personalUpdate: winIdentity }));
  const zipName = 'cindy-unversioned-x64.zip';
  fs.writeFileSync(path.join(artifactDir, zipName), await zip.generateAsync({ type: 'nodebuffer' }));
  const info = { personalUpdate: winIdentity, commitSha: sourceCommit, platform: 'win32', arch: 'x64', region: 'global', versionless: true,
    files: [{ name: zipName, size: fs.statSync(path.join(artifactDir, zipName)).size, sha256: hashFile(path.join(artifactDir, zipName)) }] };
  fs.writeFileSync(path.join(artifactDir, 'build-info.json'), JSON.stringify(info));
  fs.writeFileSync(path.join(artifactDir, 'cindy-unversioned-Setup.exe'), 'unit installer bytes');
  const manifest = await preparePersonalUpdate({ desktopRoot, artifactDir });
  assert.equal(manifest.asset.url, `https://github.com/kiwabb/cindy/releases/download/personal-windows-x64-r12301/${zipName}`);
  // The display build time comes from the packaged metadata and lands in the written feed file.
  assert.equal(manifest.builtAt, '2026-11-11T00:53:59.613+00:00');
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'personal-update.json'), 'utf8')).builtAt, manifest.builtAt);
  assert.match(fs.readFileSync(path.join(artifactDir, 'SHA256SUMS'), 'utf8'), /cindy-unversioned-Setup\.exe/);
  fs.writeFileSync(path.join(artifactDir, 'build-info.json'), JSON.stringify({ ...info, files: [{ ...info.files[0], name: 'cindy-unversioned-arm64.zip' }] }));
  await assert.rejects(preparePersonalUpdate({ desktopRoot, artifactDir }), /Windows packaged ZIP/);
});
