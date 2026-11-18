import type { IpcMainInvokeEvent } from 'electron';
import { throwIpcError } from '../utils/ipcValidate.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CompanionMemorySelection } from './companionMemoryRuntime.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

import type { MemoryPreviewStatus } from '../../shared/botMemory.js';
interface Config {
  schema: 1;
  revision: string;
  enabled: boolean;
  selection?: CompanionMemorySelection;
}
export function createCompanionMemoryPreview(deps: {
  owner(): { root: string; id: string; assertCurrent(): void };
  target(botId: string): Promise<CompanionMemorySelection>;
  botForSession(sessionId: string): Promise<string | null>;
  activate(selection: CompanionMemorySelection): Promise<void>;
  ensure(sessionId: string): Promise<void>;
  deactivate(sessionId: string): void;
  reportFailure?(sessionId: string, error: unknown): void;
}) {
  const serial = new Map<string, Promise<unknown>>();
  const active = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  let epoch = 0;
  function context(botId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) throw Error('MEMORY_PREVIEW_INVALID_BOT');
    const owner = deps.owner();
    owner.assertCurrent();
    const directory = path.join(owner.root, 'bots', botId);
    if (fs.realpathSync(directory) !== directory)
      throw Error('MEMORY_PREVIEW_PRIVATE_DIRECTORY_REQUIRED');
    return { owner, file: path.join(directory, 'companion-memory-preview.json') };
  }
  function read(file: string): Config {
    try {
      for (const candidate of [file, `${file}.bak`]) {
        try {
          const stat = fs.lstatSync(candidate);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
            throw Error('MEMORY_PREVIEW_CONFIG_INVALID');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const content = readAtomicFileSync(file);
      if (content === null) return { schema: 1, revision: 'none', enabled: false };
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
        throw Error('MEMORY_PREVIEW_CONFIG_INVALID');
      const value = JSON.parse(content) as Config;
      if (
        value.schema !== 1 ||
        typeof value.enabled !== 'boolean' ||
        typeof value.revision !== 'string' ||
        (value.enabled && !value.selection)
      )
        throw Error('MEMORY_PREVIEW_CONFIG_INVALID');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schema: 1, revision: 'none', enabled: false };
      throw error;
    }
  }
  function stop(sessionId: string) {
    active.delete(sessionId);
    deps.deactivate(sessionId);
  }
  async function status(botId: string): Promise<MemoryPreviewStatus> {
    const { owner, file } = context(botId),
      config = read(file);
    let target: CompanionMemorySelection | undefined;
    try {
      target = await deps.target(botId);
    } catch {
      /* Unsupported route does not prevent disabling or viewing saved memories. */
    }
    owner.assertCurrent();
    const matches = !config.enabled || JSON.stringify(config.selection) === JSON.stringify(target);
    return {
      botId,
      enabled: config.enabled,
      revision: config.revision,
      model: target?.route.model ?? config.selection?.route.model ?? null,
      available: !!target && matches,
      reason: !target ? 'route-unavailable' : !matches ? 'route-changed' : null,
    };
  }
  async function set(
    botId: string,
    enabled: boolean,
    expectedRevision: string,
  ): Promise<MemoryPreviewStatus> {
    if (typeof enabled !== 'boolean' || typeof expectedRevision !== 'string')
      throw Error('MEMORY_PREVIEW_INVALID_INPUT');
    const captured = context(botId);
    const previous = serial.get(captured.file) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        captured.owner.assertCurrent();
        const old = read(captured.file);
        if (old.revision !== expectedRevision) throw Error('MEMORY_PREVIEW_CHANGED');
        const selection = enabled ? await deps.target(botId) : undefined;
        captured.owner.assertCurrent();
        if (
          selection &&
          (selection.ownerId !== captured.owner.id ||
            selection.botId !== botId ||
            selection.companionState)
        )
          throw Error('MEMORY_PREVIEW_SCOPE_CHANGED');
        // Flush the preference before changing the live binding. No model call on toggle.
        atomicWriteFileSync(
          captured.file,
          JSON.stringify({
            schema: 1,
            revision: randomUUID(),
            enabled,
            ...(selection ? { selection } : {}),
          }),
        );
        if (old.selection) stop(old.selection.sessionId);
        if (selection) stop(selection.sessionId);
        return status(botId);
      });
    serial.set(captured.file, work);
    try {
      return await work;
    } finally {
      if (serial.get(captured.file) === work) serial.delete(captured.file);
    }
  }
  async function ensureCurrent(sessionId: string, capturedEpoch: number) {
    const owner = deps.owner();
    const assertEpoch = () => {
      owner.assertCurrent();
      if (epoch !== capturedEpoch) throw Error('MEMORY_PREVIEW_DISPOSED');
    };
    const botId = await deps.botForSession(sessionId);
    assertEpoch();
    if (!botId) {
      if (active.has(sessionId)) stop(sessionId);
      return;
    }
    // A disabled optional feature must not require a materialized/canonical bot directory.
    // Keep strict filesystem checks for activation and the explicit settings API only.
    try {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) throw Error('MEMORY_PREVIEW_INVALID_BOT');
      const file = path.join(owner.root, 'bots', botId, 'companion-memory-preview.json');
      const config = read(file);
      if (!config.enabled) {
        if (active.has(sessionId)) stop(sessionId);
        return;
      }
      context(botId);
      const assertConfig = () => {
        assertEpoch();
        if (read(file).revision !== config.revision || !read(file).enabled) {
          stop(sessionId);
          throw Error('MEMORY_PREVIEW_CHANGED');
        }
      };
      let target: CompanionMemorySelection;
      try { target = await deps.target(botId); }
      catch {
        assertConfig();
        // Preserve the explicit selection, but detach recall/extraction while its source is unavailable.
        stop(sessionId);
        return;
      }
      assertConfig();
      if (
        target.sessionId !== sessionId ||
        target.ownerId !== owner.id ||
        JSON.stringify(target) !== JSON.stringify(config.selection)
      ) {
        stop(sessionId);
        return;
      }
      const key = `${owner.root}:${config.revision}`;
      if (active.get(sessionId) !== key) {
        stop(sessionId);
        await deps.activate(target);
        try {
          assertConfig();
        } catch (error) {
          stop(sessionId);
          throw error;
        }
        active.set(sessionId, key);
      }
      await deps.ensure(sessionId);
      assertConfig();
    } catch (error) {
      stop(sessionId);
      // Memory failures detach recall/extraction; never relax the account/disposal fence.
      assertEpoch();
      deps.reportFailure?.(sessionId, error);
    }
  }
  function ensure(sessionId: string): Promise<void> {
    const previous = pending.get(sessionId) ?? Promise.resolve();
    const capturedEpoch = epoch;
    const work = previous.catch(() => {}).then(() => ensureCurrent(sessionId, capturedEpoch));
    pending.set(sessionId, work);
    void work
      .finally(() => {
        if (pending.get(sessionId) === work) pending.delete(sessionId);
      })
      .catch(() => {});
    return work;
  }
  return {
    status,
    set,
    ensure,
    dispose() {
      epoch++;
      for (const id of [...active.keys()]) stop(id);
    },
  };
}
let installed: ReturnType<typeof createCompanionMemoryPreview> | undefined;
export function installCompanionMemoryPreview(
  value: ReturnType<typeof createCompanionMemoryPreview>,
) {
  installed = value;
}
export function companionMemoryPreview() {
  if (!installed) throw Error('MEMORY_PREVIEW_NOT_READY');
  return installed;
}

/** Registered by the actual bot IPC entry; caller supplies no owner, path or route. */
export function registerCompanionMemoryPreviewIpc(deps: {
  ipc: {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>,
    ): unknown;
    removeHandler(channel: string): unknown;
  };
  assertTrusted(event: IpcMainInvokeEvent): void;
  captureOwner(): { assertCurrent(): void };
  getService(): ReturnType<typeof createCompanionMemoryPreview>;
}) {
  let disposed = false;
  const channels: string[] = [];
  for (const operation of ['get', 'set'] as const) {
    const channel = `local-db:bots:memory-preview:${operation}`;
    channels.push(channel);
    deps.ipc.handle(channel, async (event, raw) => {
      deps.assertTrusted(event);
      const owner = deps.captureOwner();
      const current = () => {
        owner.assertCurrent();
        if (disposed) throwIpcError('PRECONDITION_FAILED', 'Memory preview disposed');
      };
      current();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throwIpcError('INVALID_PARAMS', 'Invalid memory preview request');
      const body = raw as Record<string, unknown>,
        keys = operation === 'get' ? ['botId'] : ['botId', 'enabled', 'expectedRevision'];
      if (Object.keys(body).some((k) => !keys.includes(k)) || typeof body.botId !== 'string')
        throwIpcError('INVALID_PARAMS', 'Invalid memory preview request');
      const service = deps.getService();
      const value =
        operation === 'get'
          ? await service.status(body.botId)
          : await service.set(body.botId, body.enabled as boolean, body.expectedRevision as string);
      current();
      return value;
    });
  }
  return () => {
    disposed = true;
    for (const channel of channels) deps.ipc.removeHandler(channel);
  };
}
