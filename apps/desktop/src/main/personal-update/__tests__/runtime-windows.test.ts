import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', fetch: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: (name: string) => name === 'exe'
  ? path.join(fixture.root, 'install', 'Cindy.exe') : path.join(fixture.root, 'user-data') }, net: { fetch: fixture.fetch }, utilityProcess: {} }));
import { checkPersonalManifest, personalUpdateContext, readPreparedPersonalUpdate, notePersonalRendererCommitted, notePersonalStorageOpened,
  reconcileWindowsPersonalUpdate } from '../runtime';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const identity = { schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-windows-x64', revision: 42,
  sourceCommit: 'a'.repeat(40), platform: 'win32', arch: 'x64', region: 'global', bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64) };
const optIn = () => path.join(fixture.root, 'user-data', 'personal-app-update.json');
const root = () => path.join(fixture.root, 'user-data', 'personal-app-updates');
const touch = (name: string, value = '{}') => fs.writeFileSync(path.join(root(), name), value);
const exists = (name: string) => fs.existsSync(path.join(root(), name));

beforeAll(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-windows-test-'));
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: path.join(fixture.root, 'install', 'resources') });
  fs.mkdirSync(path.join(fixture.root, 'install', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'install', 'resources', 'cindy-source.json'), JSON.stringify({ sourceCommit: identity.sourceCommit, personalUpdate: identity }));
});
beforeEach(() => {
  fs.rmSync(path.join(fixture.root, 'user-data'), { recursive: true, force: true });
  fs.mkdirSync(root(), { recursive: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform); Object.defineProperty(process, 'arch', originalArch);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else Reflect.deleteProperty(process, 'resourcesPath');
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('Windows personal update context', () => {
  it('requires the explicit opt-in file and reports a writable install directory', () => {
    expect(personalUpdateContext()).toBeNull();
    fs.writeFileSync(optIn(), '{"enabled":true,"extra":1}');
    expect(personalUpdateContext()).toBeNull();
    fs.writeFileSync(optIn(), '{"enabled":true}');
    const context = personalUpdateContext();
    expect(context).toMatchObject({ identity: { revision: 42, platform: 'win32' }, root: root() });
    expect(context?.installDirWritable).toBe(true);
    expect(fs.readdirSync(path.join(fixture.root, 'install')).filter(name => name.startsWith('.cindy-write-probe'))).toEqual([]);
  });

  it('accepts a prepared Windows update only without a team identity', () => {
    fs.writeFileSync(optIn(), '{"enabled":true}');
    const zip = path.join(root(), 'personal-43.zip');
    fs.writeFileSync(zip, 'zip');
    const prepared = { path: zip, sha256: 'c'.repeat(64), size: 3, identity: { ...identity, revision: 43 } };
    touch('ready.json', JSON.stringify(prepared));
    expect(readPreparedPersonalUpdate()).toEqual(prepared);
    touch('ready.json', JSON.stringify({ ...prepared, teamId: 'ABCDEFGHIJ' }));
    expect(readPreparedPersonalUpdate()).toBeNull();
  });
});

describe('Windows personal update feed check', () => {
  const feed = (revision: number, storageIdentity: string) => JSON.stringify({ ...identity, revision, storageIdentity,
    asset: { url: `https://github.com/kiwabb/cindy/releases/download/personal-windows-x64-r${revision}/app.zip`, sha256: 'c'.repeat(64), size: 100 } });
  const serve = (text: string) => fixture.fetch.mockResolvedValueOnce({ ok: true, text: async () => text });

  it('offers a manual install for a newer release with another storage identity, and nothing for an older or failed one', async () => {
    fs.writeFileSync(optIn(), '{"enabled":true}');
    serve(feed(43, identity.storageIdentity));
    await expect(checkPersonalManifest()).resolves.toMatchObject({ kind: 'install', manifest: { revision: 43 } });
    serve(feed(43, 'd'.repeat(64)));
    await expect(checkPersonalManifest()).resolves.toMatchObject({ kind: 'manual', manifest: { revision: 43 } });
    // The revision test comes first: an equal or older release is no update whatever its storage identity.
    serve(feed(42, 'd'.repeat(64)));
    await expect(checkPersonalManifest()).resolves.toBeNull();
    serve(feed(41, 'd'.repeat(64)));
    await expect(checkPersonalManifest()).resolves.toBeNull();
    touch('failed-43.json');
    serve(feed(43, 'd'.repeat(64)));
    await expect(checkPersonalManifest()).resolves.toBeNull();
  });
});

describe('Windows personal update startup and health', () => {
  it('records a never-started target as failed and keeps a target that is not newer than the running revision', () => {
    fs.writeFileSync(optIn(), '{"enabled":true}');
    touch('applying-43.json'); touch('applying-42.json'); touch('ready.json'); touch('personal-43.zip');
    reconcileWindowsPersonalUpdate(personalUpdateContext()!);
    expect(JSON.parse(fs.readFileSync(path.join(root(), 'failed-43.json'), 'utf8'))).toEqual({ revision: 43, phase: 'windows-apply-failed' });
    expect([exists('applying-43.json'), exists('ready.json'), exists('personal-43.zip')]).toEqual([false, false, false]);
    expect(exists('applying-42.json')).toBe(true);
    expect(exists('failed-42.json')).toBe(false);
  });

  it('clears applying markers and obsolete staging once storage and the renderer agree', () => {
    fs.writeFileSync(optIn(), '{"enabled":true}');
    touch('applying-42.json'); touch('personal-42.zip'); touch('incoming-41.zip'); touch('personal-43.zip'); touch('applying-43.json');
    touch('ready.json', JSON.stringify({ identity }));
    notePersonalStorageOpened('owner', 'cloud', 7);
    expect(exists('applying-42.json')).toBe(true);
    notePersonalRendererCommitted('owner', 'cloud', 7);
    expect([exists('applying-42.json'), exists('personal-42.zip'), exists('incoming-41.zip'), exists('ready.json')]).toEqual([false, false, false, false]);
    expect([exists('personal-43.zip'), exists('applying-43.json')]).toEqual([true, true]);
  });
});
