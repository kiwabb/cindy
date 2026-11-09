/* global process */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validatePersonalIdentity, validatePersonalPolicy } from '../../src/main/personal-update/contract.mjs';

export function readPersonalUpdatePolicy(desktopRoot) {
  return validatePersonalPolicy(JSON.parse(fs.readFileSync(path.join(desktopRoot, 'personal-update-channel.json'), 'utf8')));
}

/** The same persisted bytes must remain readable by both sides of an automatic replacement. */
export function computeStorageIdentity(desktopRoot, policy = readPersonalUpdatePolicy(desktopRoot)) {
  validatePersonalPolicy(policy);
  const files = [];
  function collect(relative) {
    for (const entry of fs.readdirSync(path.join(desktopRoot, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Storage contract cannot contain a symlink: ${name}`);
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile() && !/^\d+_snapshot\.json$/.test(entry.name)) files.push(name);
    }
  }
  collect('drizzle');
  files.push(
    'src/main/localDb/schema.ts',
    'src/main/maker-ipc/personalTodoStore.ts',
    'src/main/maker-ipc/botTodoStore.ts',
    '../../packages/maker-shared/src/teammateTodo.ts',
  );
  if (!files.some(name => /^drizzle\/\d+_.*\.sql$/.test(name)) || !files.includes('drizzle/meta/_journal.json')) {
    throw new Error('Storage contract requires migration SQL and journal');
  }
  const hash = createHash('sha256');
  hash.update(`cindy-personal-storage-v1\0${policy.storageCompatibilityVersion}\0`);
  for (const name of files.sort()) {
    const file = path.join(desktopRoot, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Storage contract requires a regular file: ${name}`);
    const content = fs.readFileSync(file);
    hash.update(`${name}\0${content.length}\0`).update(content).update('\0');
  }
  return hash.digest('hex');
}

export function parsePersonalRevision(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Personal update revision must be a positive safe integer');
  }
  return Number(value);
}

export function personalRevisionForRun(runId, attempt) {
  const run = parsePersonalRevision(runId);
  const retry = parsePersonalRevision(attempt);
  const revision = run * 100 + retry;
  if (retry >= 100 || !Number.isSafeInteger(revision)) throw new Error('Personal update revision overflow');
  return revision;
}

export function buildPersonalUpdateIdentity({ desktopRoot, sourceCommit, revision = process.env.CINDY_PERSONAL_UPDATE_REVISION }) {
  if (revision === undefined || revision === '') return null;
  const policy = readPersonalUpdatePolicy(desktopRoot);
  return validatePersonalIdentity({
    schemaVersion: 1,
    repository: policy.repository,
    channel: policy.channel,
    revision: parsePersonalRevision(revision),
    sourceCommit,
    platform: 'darwin',
    arch: 'arm64',
    region: 'global',
    bundleIdentifier: 'com.xd.cindy',
    storageIdentity: computeStorageIdentity(desktopRoot, policy),
  }, policy);
}

/** Run before the packager temporarily changes package.json and generated source metadata. */
export function assertPersonalUpdateBuildSource({ desktopRoot, sourceCommit, platform, archs, region, versionSpec, skipSmoke }) {
  if (platform !== 'darwin' || archs.length !== 1 || archs[0] !== 'arm64' || region !== 'global' || versionSpec || skipSmoke) {
    throw new Error('Personal updates require unversioned Global darwin-arm64 packaging with smoke enabled');
  }
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: desktopRoot, encoding: 'utf8' });
  if (status.trim()) throw new Error('Personal updates require a clean committed source tree');
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) throw new Error('Personal update source differs from GITHUB_SHA');
}
