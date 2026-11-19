// Filesystem fixtures only: no Electron, credentials, chat or model calls.
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompanionMemoryPreview } from '../companionMemoryPreview.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-preview-fixture-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'bots', 'bot-fixture'), { recursive: true });
  let current = true;
  let target = {
    ownerId: 'owner-fixture',
    botId: 'bot-fixture',
    sessionId: 'session-fixture',
    route: {
      providerId: 'fixture',
      model: 'fixture-model',
      protocol: 'openai-responses' as const,
      baseUrl: 'http://127.0.0.1:1/v1',
    },
  };
  const deps = {
    owner: () => ({
      root,
      id: 'owner-fixture',
      assertCurrent() {
        if (!current) throw Error('OWNER_CHANGED');
      },
    }),
    target: vi.fn(async () => target),
    botForSession: vi.fn(async () => target.botId),
    activate: vi.fn(async () => {}),
    ensure: vi.fn(async () => {}),
    deactivate: vi.fn(),
  };
  return {
    deps,
    root,
    preview: createCompanionMemoryPreview(deps),
    changeOwner() {
      current = false;
    },
    changeRoute() {
      target = { ...target, route: { ...target.route, model: 'changed-model' } };
    },
  };
}
it('defaults off; enabling persists without a model/binding; restart uses the same selected route', async () => {
  const f = fixture();
  expect(await f.preview.status('bot-fixture')).toMatchObject({
    enabled: false,
    revision: 'none',
    available: true,
  });
  await f.preview.ensure('session-fixture');
  expect(f.deps.activate).not.toHaveBeenCalled();
  await f.preview.set('bot-fixture', true, 'none');
  expect(f.deps.activate).not.toHaveBeenCalled();
  const reopened = createCompanionMemoryPreview(f.deps);
  await reopened.ensure('session-fixture');
  expect(f.deps.activate).toHaveBeenCalledOnce();
  await reopened.ensure('session-fixture');
  expect(f.deps.activate).toHaveBeenCalledOnce();
  expect(
    JSON.parse(
      fs.readFileSync(path.join(f.root, 'bots/bot-fixture/companion-memory-preview.json'), 'utf8'),
    ).selection.companionState,
  ).toBeUndefined();
});
it('serializes concurrent sends and rejects stale setting revisions', async () => {
  const f = fixture();
  await f.preview.set('bot-fixture', true, 'none');
  await Promise.all([f.preview.ensure('session-fixture'), f.preview.ensure('session-fixture')]);
  expect(f.deps.activate).toHaveBeenCalledOnce();
  await expect(f.preview.set('bot-fixture', false, 'none')).rejects.toThrow('CHANGED');
});
it('changed route never silently selects a replacement and can still be disabled', async () => {
  const f = fixture();
  const status = await f.preview.set('bot-fixture', true, 'none');
  f.changeRoute();
  expect(await f.preview.status('bot-fixture')).toMatchObject({
    enabled: true,
    available: false,
    reason: 'route-changed',
  });
  await expect(f.preview.ensure('session-fixture')).resolves.toBeUndefined();
  expect(f.deps.activate).not.toHaveBeenCalled();
  expect(await f.preview.set('bot-fixture', false, status.revision)).toMatchObject({
    enabled: false,
  });
});
it.each(['disable', 'dispose', 'owner'] as const)(
  'revokes an activation awaiting completion: %s',
  async (action) => {
    const f = fixture();
    const status = await f.preview.set('bot-fixture', true, 'none');
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    f.deps.activate.mockImplementation(async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const work = f.preview.ensure('session-fixture');
    await ready;
    if (action === 'disable') await f.preview.set('bot-fixture', false, status.revision);
    else if (action === 'dispose') f.preview.dispose();
    else f.changeOwner();
    release();
    if (action === 'disable') await expect(work).resolves.toBeUndefined();
    else await expect(work).rejects.toThrow();
    expect(f.deps.ensure).not.toHaveBeenCalled();
    expect(f.deps.deactivate).toHaveBeenLastCalledWith('session-fixture');
  },
);
it('restores atomic Windows backup and rejects a symlink instead of reading another bot', async () => {
  const f = fixture();
  await f.preview.set('bot-fixture', true, 'none');
  const file = path.join(f.root, 'bots/bot-fixture/companion-memory-preview.json');
  fs.renameSync(file, `${file}.bak`);
  expect(await f.preview.status('bot-fixture')).toMatchObject({ enabled: true });
  expect(fs.existsSync(file)).toBe(true);
  fs.renameSync(file, `${file}.other`);
  fs.symlinkSync(`${file}.other`, file);
  await expect(f.preview.status('bot-fixture')).rejects.toThrow('CONFIG_INVALID');
  await expect(f.preview.status('../bot-fixture')).rejects.toThrow('INVALID_BOT');
});

import { registerCompanionMemoryPreviewIpc } from '../companionMemoryPreview.js';
it('production IPC registration rejects path injection/untrusted callers and late owner responses', async () => {
  const f = fixture(),
    handlers = new Map<string, any>();
  let trusted = true;
  const dispose = registerCompanionMemoryPreviewIpc({
    ipc: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: (name) => handlers.delete(name),
    },
    assertTrusted() {
      if (!trusted) throw Error('UNTRUSTED');
    },
    captureOwner: f.deps.owner,
    getService: () => f.preview,
  });
  const get = handlers.get('local-db:bots:memory-preview:get'),
    set = handlers.get('local-db:bots:memory-preview:set');
  await expect(get({}, { botId: 'bot-fixture', path: '/other' })).rejects.toThrow('INVALID_PARAMS');
  trusted = false;
  await expect(
    set({}, { botId: 'bot-fixture', enabled: true, expectedRevision: 'none' }),
  ).rejects.toThrow('UNTRUSTED');
  trusted = true;
  let release!: (value: any) => void;
  f.deps.target.mockImplementation(() => new Promise((r) => (release = r)));
  const work = get({}, { botId: 'bot-fixture' });
  f.changeOwner();
  release(undefined);
  await expect(work).rejects.toThrow('OWNER_CHANGED');
  dispose();
  expect(handlers.size).toBe(0);
  await expect(get({}, { botId: 'bot-fixture' })).rejects.toThrow();
});

it('unavailable source detaches memory without falling back or blocking ordinary sends', async () => {
  const f=fixture(); await f.preview.set('bot-fixture',true,'none');
  await f.preview.ensure('session-fixture'); f.deps.activate.mockClear(); f.deps.ensure.mockClear();
  f.deps.target.mockRejectedValue(Error('REMOTE_OFFLINE'));
  await expect(f.preview.ensure('session-fixture')).resolves.toBeUndefined();
  expect(f.deps.deactivate).toHaveBeenCalledWith('session-fixture');
  expect(f.deps.activate).not.toHaveBeenCalled(); expect(f.deps.ensure).not.toHaveBeenCalled();
  f.changeOwner(); await expect(f.preview.ensure('session-fixture')).rejects.toThrow('OWNER_CHANGED');
});

it.each(['missing-directory', 'redirected-directory', 'invalid-config'])('disabled preview cannot block ordinary sends: %s', async kind => {
  const f = fixture();
  const directory = path.join(f.root, 'bots', 'bot-fixture');
  if (kind === 'missing-directory') fs.rmSync(directory, { recursive: true });
  if (kind === 'redirected-directory') {
    const target = path.join(f.root, 'redirect-target'); fs.renameSync(directory, target);
    fs.symlinkSync(target, directory, 'junction');
  }
  if (kind === 'invalid-config') fs.writeFileSync(path.join(directory, 'companion-memory-preview.json'), '{broken');
  await expect(f.preview.ensure('session-fixture')).resolves.toBeUndefined();
  expect(f.deps.activate).not.toHaveBeenCalled(); expect(f.deps.ensure).not.toHaveBeenCalled();
});
it('an unavailable private store detaches memory without blocking ordinary sends', async () => {
  const f=fixture(); await f.preview.set('bot-fixture', true, 'none');
  f.deps.activate.mockRejectedValue(new Error('COMPANION_SHARED_WORKSPACE'));
  await expect(f.preview.ensure('session-fixture')).resolves.toBeUndefined();
  expect(f.deps.deactivate).toHaveBeenCalledWith('session-fixture');
});
it('memory failure does not swallow an owner change', async () => {
  const f=fixture(); await f.preview.set('bot-fixture', true, 'none');
  f.deps.activate.mockImplementation(async()=>{f.changeOwner();throw Error('STORE_FAILED');});
  await expect(f.preview.ensure('session-fixture')).rejects.toThrow('OWNER_CHANGED');
});
