#!/usr/bin/env node
/* global console, process */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readPersonalUpdatePolicy, personalRevisionForRun, parsePersonalRevision } from './ci/personal-update-metadata.mjs';
import { createPersonalUpdateManifest, hashFile, personalReleaseAssets } from './ci/personal-update-artifacts.mjs';
import { validatePersonalManifest } from '../src/main/personal-update/contract.mjs';

export function assertPublicationContext(manifest, env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== manifest.repository
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_SHA !== manifest.sourceCommit
    || personalRevisionForRun(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT) !== manifest.revision) {
    throw new Error('Personal updates may only publish the trusted main workflow source and revision');
  }
}

export function assertChannelAdvance(current, candidate) {
  if (!current) return;
  if (current.revision > candidate.revision) throw new Error('Refusing to downgrade the personal update channel');
  if (current.revision === candidate.revision && !isDeepStrictEqual(current, candidate)) {
    throw new Error('A personal update revision cannot be replaced with different bytes');
  }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
}

export function publishPersonalUpdate({ artifactDir, desktopRoot, env = process.env, runGh = gh }) {
  const info = JSON.parse(fs.readFileSync(path.join(artifactDir, 'build-info.json'), 'utf8'));
  const policy = readPersonalUpdatePolicy(desktopRoot, info.platform, info.arch);
  const candidate = createPersonalUpdateManifest({ buildInfo: info, artifactDir, policy });
  const supplied = validatePersonalManifest(JSON.parse(fs.readFileSync(path.join(artifactDir, 'personal-update.json'), 'utf8')), policy);
  if (!isDeepStrictEqual(candidate, supplied)) throw new Error('Published manifest does not describe the verified ZIP');
  assertPublicationContext(candidate, env);
  const repository = policy.repository;
  const tag = `${policy.channel}-r${candidate.revision}`;
  const files = personalReleaseAssets(policy).files;
  const label = candidate.platform === 'win32' ? { name: 'Windows x64', payload: 'Global Windows x64 payload. Run the Setup.exe for a first manual installation.', title: 'Windows' }
    : { name: 'Mac', payload: 'Global Apple Silicon payload. Locally re-sign before installation.', title: 'Mac' };
  const expected = new Map(files.map(name => [name, { size: fs.statSync(path.join(artifactDir, name)).size, sha256: hashFile(path.join(artifactDir, name)) }]));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-publish-'));
  fs.chmodSync(temp, 0o700);
  const api = endpoint => JSON.parse(runGh(['api', `repos/${repository}/${endpoint}`]));
  function releaseById(id, tagName) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid release ID');
    const value = api(`releases/${id}`);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.draft !== 'boolean'
      || !Array.isArray(value.assets) || typeof value.target_commitish !== 'string' || !value.target_commitish) {
      throw new Error('Invalid release metadata');
    }
    if (value.id !== id || value.tag_name !== tagName) throw new Error('Release ID does not match the expected tag');
    return value;
  }
  function release(tagName) {
    try {
      const published = api(`releases/tags/${tagName}`);
      return releaseById(published.id, tagName);
    } catch (error) {
      // This endpoint only returns published releases. Other failures remain fatal.
      if (!/HTTP 404/.test(String(error.stderr ?? error.message))) throw error;
    }
    // Drafts have no published tag lookup. Search every page for this exact tag,
    // rejecting distinct draft IDs instead of selecting an arbitrary recovery target.
    let matchingId;
    for (let page = 1; ; page++) {
      const values = api(`releases?per_page=100&page=${page}`);
      if (!Array.isArray(values)) throw new Error('Invalid release listing');
      for (const value of values.filter(item => item.tag_name === tagName)) {
        if (!Number.isSafeInteger(value.id) || value.id <= 0) throw new Error('Invalid release ID');
        if (matchingId !== undefined && matchingId !== value.id) throw new Error('Ambiguous releases for the expected tag');
        matchingId = value.id;
      }
      if (values.length < 100) return matchingId === undefined ? null : releaseById(matchingId, tagName);
    }
  }
  function createImmutableDraft() {
    const input = path.join(temp, 'draft-release.json');
    fs.writeFileSync(input, JSON.stringify({ tag_name: tag, target_commitish: candidate.sourceCommit,
      draft: true, make_latest: 'false', name: `Cindy ${label.name} personal revision ${candidate.revision}`,
      body: `Source ${candidate.sourceCommit}. ${label.payload}`,
    }), { mode: 0o600 });
    let created;
    try {
      created = JSON.parse(runGh(['api', `repos/${repository}/releases`, '--method', 'POST', '--input', input]));
    } catch (error) {
      // Recover only a documented duplicate tag conflict. A validation, access or
      // transport failure must not be reinterpreted as a successful creation.
      let detail;
      try { detail = JSON.parse(String(error.stdout)); } catch { throw error; }
      if (!/HTTP 422/.test(String(error.stderr ?? error.message))
        || !Array.isArray(detail?.errors)
        || !detail.errors.some(item => item.resource === 'Release' && item.field === 'tag_name' && item.code === 'already_exists')) throw error;
      const existing = release(tag);
      if (!existing) throw error;
      return existing;
    }
    return releaseById(created.id, tag);
  }
  function download(tagName, name) {
    const dir = fs.mkdtempSync(path.join(temp, 'asset-'));
    runGh(['release', 'download', tagName, '--repo', repository, '--pattern', name, '--dir', dir]);
    return path.join(dir, name);
  }
  function currentChannel() {
    const current = release(policy.channel);
    if (!current) return null;
    if (current.draft) throw new Error('Personal update channel must be published');
    const match = /^Personal update revision (\d+)$/m.exec(current.body ?? '');
    const floor = match ? parsePersonalRevision(match[1]) : 0;
    if (floor > candidate.revision) throw new Error('Refusing to downgrade the personal update channel floor');
    const asset = current.assets.find(item => item.name === 'personal-update.json');
    if (!asset) {
      if (!floor) throw new Error('Channel manifest is missing without a recoverable revision floor');
      return { manifest: null, floor };
    }
    return { manifest: validatePersonalManifest(JSON.parse(fs.readFileSync(download(policy.channel, 'personal-update.json'), 'utf8')), policy), floor };
  }
  function verifyReleaseTag() {
    let object = api(`git/ref/tags/${tag}`).object;
    for (let depth = 0; depth < 5; depth++) {
      if (!object || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Invalid immutable release tag object');
      if (object.type === 'commit') {
        if (object.sha !== candidate.sourceCommit) throw new Error('Immutable release tag points to another source');
        return;
      }
      if (object.type !== 'tag') throw new Error('Invalid immutable release tag type');
      object = api(`git/tags/${object.sha}`).object;
    }
    throw new Error('Immutable release tag has too many indirections');
  }
  function verifyAssets(value) {
    for (const [name, file] of expected) {
      const asset = value.assets.find(item => item.name === name);
      if (!asset || asset.size !== file.size) throw new Error(`Missing or wrong-sized immutable asset: ${name}`);
      if (asset.digest) {
        if (asset.digest !== `sha256:${file.sha256}`) throw new Error(`Immutable asset hash mismatch: ${name}`);
      } else if (hashFile(download(tag, name)) !== file.sha256) throw new Error(`Immutable asset hash mismatch: ${name}`);
    }
  }
  try {
    const head = api('branches/main');
    if (head.commit.sha !== candidate.sourceCommit) throw new Error('Main advanced while building; publish its newer workflow instead');
    assertChannelAdvance(currentChannel()?.manifest, candidate);
    let immutable = release(tag);
    if (!immutable) immutable = createImmutableDraft();
    if (immutable.target_commitish !== candidate.sourceCommit) throw new Error('Immutable release points to another source');
    for (const name of files) {
      if (!immutable.assets.some(asset => asset.name === name)) {
        if (!immutable.draft) throw new Error('Published immutable release is incomplete');
        runGh(['release', 'upload', tag, path.join(artifactDir, name), '--repo', repository]);
      }
    }
    immutable = releaseById(immutable.id, tag);
    verifyAssets(immutable);
    if (immutable.draft) runGh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest=false']);
    if (releaseById(immutable.id, tag).draft) throw new Error('Immutable release is still a draft');
    verifyReleaseTag();
    // All immutable bytes are public and verified before the mutable pointer is advanced.
    const current = currentChannel();
    assertChannelAdvance(current?.manifest, candidate);
    if (current?.manifest?.revision === candidate.revision && current.floor === candidate.revision) return candidate;
    const notes = `Personal update revision ${candidate.revision}\nSource ${candidate.sourceCommit}`;
    // Persist the high-water mark before --clobber can delete the previous asset.
    // A failed upload can then be repaired at the same revision, never downgraded.
    if (!current) {
      runGh(['release', 'create', policy.channel, '--repo', repository, '--target', candidate.sourceCommit,
        '--latest=false', '--title', `Cindy personal ${label.title} update channel`,
        '--notes', notes]);
    } else {
      runGh(['release', 'edit', policy.channel, '--repo', repository, '--latest=false', '--notes', notes]);
    }
    const reserved = currentChannel();
    if (reserved?.floor !== candidate.revision) throw new Error('Channel revision floor was not persisted');
    assertChannelAdvance(reserved.manifest, candidate);
    if (current?.manifest?.revision !== candidate.revision) {
      runGh(['release', 'upload', policy.channel, path.join(artifactDir, 'personal-update.json'), '--repo', repository, '--clobber']);
    }
    const observed = currentChannel()?.manifest;
    if (!isDeepStrictEqual(observed, candidate)) throw new Error('Published channel verification failed');
    return candidate;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: publish-personal-update.mjs <artifact-directory>');
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = publishPersonalUpdate({ artifactDir: path.resolve(process.argv[2]), desktopRoot });
  console.log(`Published personal update revision ${result.revision}, source ${result.sourceCommit}`);
}
