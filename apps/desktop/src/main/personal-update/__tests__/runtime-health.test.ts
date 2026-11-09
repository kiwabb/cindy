import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', acknowledge: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: (name: string) => name === 'exe'
  ? '/Applications/Cindy.app/Contents/MacOS/Cindy' : path.join(fixture.root, 'user-data') }, net: {}, utilityProcess: {} }));
vi.mock('../transaction.js', async importOriginal => ({
  ...await importOriginal<typeof import('../transaction.js')>(),
  acknowledgePersonalStorageReady: fixture.acknowledge,
}));
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawnSync: (command: string, args: string[], options: object) => args[0] === '--pid-birth'
    ? { status: 0, stdout: '123:456\n', stderr: '' } : real.spawnSync(command, args, options) };
});
import { notePersonalRendererCommitted, notePersonalStorageOpened } from '../runtime';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

beforeAll(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-health-gate-test-'));
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: path.join(fixture.root, 'resources') });
  fs.mkdirSync(path.join(fixture.root, 'resources'));
  fs.mkdirSync(path.join(fixture.root, 'user-data'));
  fs.writeFileSync(path.join(fixture.root, 'user-data', 'personal-app-update.json'), '{"enabled":true}');
  fs.writeFileSync(path.join(fixture.root, 'resources', 'cindy-source.json'), JSON.stringify({ sourceCommit: 'a'.repeat(40), personalUpdate: {
    schemaVersion: 1, repository: 'kiwabb/cindy', channel: 'personal-macos-arm64', revision: 42,
    sourceCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', region: 'global',
    bundleIdentifier: 'com.xd.cindy', storageIdentity: 'b'.repeat(64),
  } }));
});
afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform); Object.defineProperty(process, 'arch', originalArch);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else Reflect.deleteProperty(process, 'resourcesPath');
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('production personal startup health intersection', () => {
  it('waits for DB and committed renderer to agree on the exact owner and mode in either order', () => {
    notePersonalStorageOpened('owner-a', 'cloud', 1);
    notePersonalRendererCommitted('owner-b', 'cloud', 1);
    expect(fixture.acknowledge).not.toHaveBeenCalled();
    notePersonalRendererCommitted('owner-a', 'cloud', 1);
    const ownerHash = createHash('sha256').update('cloud\0owner-a').digest('hex');
    expect(fixture.acknowledge).toHaveBeenCalledWith(expect.any(String), '/Applications/Cindy.app', expect.objectContaining({ revision: 42 }), ownerHash, '123:456');
    fixture.acknowledge.mockClear();
    notePersonalRendererCommitted('owner-c', 'cloud', 2);
    expect(fixture.acknowledge).not.toHaveBeenCalled();
    notePersonalStorageOpened('owner-c', 'local', 2);
    expect(fixture.acknowledge).not.toHaveBeenCalled();
    notePersonalStorageOpened('owner-c', 'cloud', 3);
    expect(fixture.acknowledge).not.toHaveBeenCalled();
    notePersonalStorageOpened('owner-c', 'cloud', 2);
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
  });
});
