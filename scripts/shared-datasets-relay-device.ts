/**
 * One simulated desktop for scripts/shared-datasets-relay-smoke.ts (bundled by esbuild, run in a
 * plain Node process with an `electron` stub; no window, no renderer).
 *
 * Real: DeviceLinkClient, the desktop inbound dispatcher (`wireInboundDispatch` / `runInvoke`, the
 * `maker:shared-datasets:v1` interception and the real allowlist), the shared-datasets engine and
 * storage, the personal-todo dataset on the real personal-todo store file, the real device-link
 * settings store (revoked controllers) and app-session owner scope.
 * Mirrored here (device-link/index.ts is not loadable without the account/REST session):
 * presence tracking, `listPeers`, the push-receive gate and the push-send port, i.e. what
 * `shared-datasets/runtime.ts` wires. Keep them in step with runtime.ts / index.ts.
 *
 * Protocol with the parent: one JSON command per stdin line `{id, cmd, args}`, one JSON reply per
 * stdout line `{id, ok, result|error}`. Environment: SMOKE_* (see below).
 */
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  DeviceLinkClient,
  REMOTE_INVOKE_ALLOWLIST,
  SHARED_DATASETS_CHANNEL,
  SHARED_DATASETS_CHANGED_CHANNEL,
  providerShareGuestPeer,
  type Envelope,
  type PresenceSnapshot,
} from '../packages/device-link/src/index';
import { isDesktopPlatform, setControllerPlatform } from '../apps/desktop/src/main/device-link/controllerPlatform';
import { configureUserDataDir } from '../apps/desktop/src/main/userDataPath';
import {
  activeOwnerScopeKey,
  commitVolatileAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../apps/desktop/src/main/appSessionState';
import { runInvoke, setSharedDatasetsRemoteHandler, wireInboundDispatch } from '../apps/desktop/src/main/device-link/dispatch.desktop';
import { readDeviceLinkSettings, updateDeviceLinkSetting } from '../apps/desktop/src/main/device-link/settings-store.desktop';
import { installSharedDatasetsEngine } from '../apps/desktop/src/main/shared-datasets/api';
import { createSharedDatasetsEngine } from '../apps/desktop/src/main/shared-datasets/engine';
import { sharedDatasetRegistry } from '../apps/desktop/src/main/shared-datasets/registry';
import type { SharedDatasetsPorts } from '../apps/desktop/src/main/shared-datasets/types';
import { registerPersonalTodoSharedDataset } from '../apps/desktop/src/main/maker-ipc/personalTodoSharedDataset';
import {
  openPersonalTodoStore,
  personalTodoSyncActions,
  readPersonalTodoSyncStatus,
  listPersonalTodoSyncConflicts,
  writePersonalTodo,
} from '../apps/desktop/src/main/maker-ipc/personalTodoAccess';
import { syncSharedDatasetNow } from '../apps/desktop/src/main/shared-datasets/api';

const env = (name: string) => process.env[name] ?? '';
const DEVICE_ID = env('SMOKE_DEVICE_ID');
const NAME = env('SMOKE_NAME');
const OLD_PEER = env('SMOKE_OLD_PEER') === '1';
/** darwin = a desktop; ios = a paired phone (same account, never a shared-dataset participant). */
const PLATFORM = env('SMOKE_PLATFORM') || 'darwin';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

configureUserDataDir(env('SMOKE_USER_DATA'));
commitVolatileAppSession('cloud', 'smoke-account');
if (OLD_PEER) {
  // An older Desktop: the channel is not in its allowlist, so dispatch answers CHANNEL_NOT_ALLOWED.
  (REMOTE_INVOKE_ALLOWLIST as Set<string>).delete(SHARED_DATASETS_CHANNEL);
}

const counters = { pushesReceived: 0, sent: {} as Record<string, number>, served: {} as Record<string, number> };
const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};

const presence = new Map<string, PresenceSnapshot>();
const client = new DeviceLinkClient({
  getWsUrl: () => env('SMOKE_RELAY_WS'),
  getToken: async () => env('SMOKE_CREDENTIAL'),
  authorizationScheme: 'CindyRelay',
  getHello: () => ({
    deviceName: NAME,
    platform: PLATFORM,
    appVersion: '0.0.0-smoke',
    remoteControlEnabled: true,
    busy: false,
  }),
  createWebSocket: (url, headers) => new WebSocket(url, { headers }),
  logger: quiet,
  peerFailurePolicy: 'legacy',
  timing: { reconnectBaseMs: 100, reconnectMaxMs: 500, requestTimeoutMs: 8_000 },
});

const isEligiblePeer = (id: string) => {
  const p = presence.get(id);
  return !!p && p.online && isDesktopPlatform(p.platform) && id !== DEVICE_ID && !readDeviceLinkSettings().revokedControllers.includes(id);
};

let engine: ReturnType<typeof createSharedDatasetsEngine> | null = null;

function ports(): SharedDatasetsPorts {
  return {
    selfDeviceId: () => DEVICE_ID,
    captureScope: () => {
      if (isAppSessionBoundaryPending()) throw new Error('app session boundary pending');
      const owner = activeOwnerScopeKey();
      return {
        owner,
        baseDir: ownerScopedUserDataPath('shared-datasets'),
        assertCurrent: () => {
          if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throw new Error('owner changed');
        },
      };
    },
    listPeers: async () =>
      [...presence.values()]
        .filter((p) => p.deviceId !== DEVICE_ID && isDesktopPlatform(p.platform))
        .map((p) => ({ deviceId: p.deviceId, name: p.deviceName, online: p.online && p.remoteControlEnabled })),
    isPeerOnline: (id) => !!presence.get(id)?.online && !!presence.get(id)?.remoteControlEnabled,
    peerName: (id) => presence.get(id)?.deviceName,
    // Same steps as remoteBackgroundInvoke: open the link if needed, then invoke.
    invoke: async (deviceId, request) => {
      bump(counters.sent, request.action);
      if (!presence.get(deviceId)?.online) return { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'offline' } };
      try {
        if (!client.isLinkReady(deviceId)) {
          await client.openLink(deviceId, { controllerName: NAME, protocolVersion: 1, appVersion: '0.0.0-smoke' });
        }
        const reply = await client.invoke(deviceId, { channel: SHARED_DATASETS_CHANNEL, args: [request] });
        return reply.ok
          ? { ok: true, result: reply.result }
          : { ok: false, error: { code: reply.error.code, message: reply.error.message } };
      } catch (error) {
        return { ok: false, error: { code: (error as { code?: string }).code ?? 'IPC_ERROR', message: String(error) } };
      }
    },
    sendChanged: (deviceId, frame) => client.sendPush(deviceId, SHARED_DATASETS_CHANGED_CHANNEL, frame),
    pushTargets: () => [...presence.keys()].filter(isEligiblePeer),
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    log: { warn: (message, meta) => console.error(`[${NAME}] ${message} ${JSON.stringify(meta ?? {})}`) },
  };
}

function startEngine() {
  registerPersonalTodoSharedDataset();
  engine = createSharedDatasetsEngine(ports(), sharedDatasetRegistry);
  installSharedDatasetsEngine(engine);
  setSharedDatasetsRemoteHandler({
    handle: (src, arg) => {
      bump(counters.served, String((arg as { action?: string })?.action));
      return engine!.handleRequest(src, arg);
    },
  });
  void engine.resume().catch(() => undefined);
}

wireInboundDispatch(client);
if (OLD_PEER) {
  // An old Desktop has no handler at all; counting proves nothing reached one.
  setSharedDatasetsRemoteHandler({
    handle: async (_src, arg) => {
      bump(counters.served, String((arg as { action?: string })?.action));
      return {};
    },
  });
} else {
  startEngine();
}

client.onStatusChange((status) => {
  if (status !== 'online') {
    // The real client forgets peers' presence when its own connection drops.
    for (const p of presence.values()) presence.set(p.deviceId, { ...p, online: false });
  }
});
client.onPresenceChanged((snap: PresenceSnapshot) => {
  if (!snap || snap.deviceId === DEVICE_ID) return;
  const before = presence.get(snap.deviceId);
  presence.set(snap.deviceId, snap);
  // What device-link/index.ts feeds the dispatcher's controller-platform registry.
  setControllerPlatform(snap.deviceId, snap.platform);
  const changed = !before || before.online !== snap.online || before.remoteControlEnabled !== snap.remoteControlEnabled;
  if (changed) engine?.onPeerPresence(snap.deviceId);
  if (snap.online && !before?.online && snap.platform === 'darwin') engine?.onPeerOnline(snap.deviceId);
});
client.onFrame((env: Envelope) => {
  if (env.kind === 'push') {
    const p = env.payload as { channel?: string; payload?: unknown } | undefined;
    if (p?.channel === SHARED_DATASETS_CHANGED_CHANNEL && env.src && isEligiblePeer(env.src)) {
      counters.pushesReceived += 1;
      engine?.handleChangedPush(env.src, p.payload);
    }
  }
});

const summary = (todo: { id: string; revision: number; title: string }) => ({ id: todo.id, revision: todo.revision, title: todo.title });

const commands: Record<string, (args: any) => Promise<unknown>> = {
  async ping() {
    return { status: client.getStatus(), deviceId: DEVICE_ID, peers: [...presence.values()].map((p) => ({ id: p.deviceId, online: p.online })) };
  },
  async list() {
    const { store } = openPersonalTodoStore();
    return (await store.list()).map(summary);
  },
  async rawCount() {
    const { store } = openPersonalTodoStore();
    return (await store.read()).items.length;
  },
  async add(args: { title: string }) {
    const written = await writePersonalTodo({ creationRequestId: `c${randomUUID().replace(/-/g, '')}`, title: args.title });
    return { ...summary(written.todo), sync: written.sync };
  },
  async edit(args: { id: string; title: string; expectedRevision?: number }) {
    // Like the UI: the edit names the revision this computer currently shows.
    const shown = args.expectedRevision ?? (await openPersonalTodoStore().store.list()).find((t) => t.id === args.id)?.revision;
    const written = await writePersonalTodo({ id: args.id, title: args.title, expectedRevision: shown });
    return { ...summary(written.todo), sync: written.sync };
  },
  async steps(args: { id: string; subtasks?: Array<{ id?: string; title: string; done?: boolean }> }) {
    if (args.subtasks) {
      const shown = (await openPersonalTodoStore().store.list()).find((t) => t.id === args.id)?.revision;
      const written = await writePersonalTodo({ id: args.id, expectedRevision: shown, subtasks: args.subtasks });
      return { sync: written.sync, steps: written.todo.subtasks };
    }
    return (await openPersonalTodoStore().store.list()).find((t) => t.id === args.id)?.subtasks ?? [];
  },
  async enable() {
    return personalTodoSyncActions.enable();
  },
  async disable() {
    return personalTodoSyncActions.disable();
  },
  async setHome() {
    return personalTodoSyncActions.setAsHome();
  },
  async status() {
    return readPersonalTodoSyncStatus();
  },
  async syncNow() {
    return syncSharedDatasetNow('personal-todos');
  },
  async conflicts() {
    return listPersonalTodoSyncConflicts();
  },
  async resolve(args: { conflictId: string; choice: 'mine' | 'theirs' }) {
    return personalTodoSyncActions.resolve(args.conflictId, args.choice);
  },
  async counters() {
    return counters;
  },
  /** Disconnects like a dead link (process and local writes stay alive). */
  async block() {
    client.stop();
    return { status: client.getStatus() };
  },
  async unblock() {
    client.start();
    return {};
  },
  /** Raw invoke of the channel to a peer through the real client (what an old/other peer answers). */
  async probe(args: { dst: string; request: Record<string, unknown> }) {
    if (!client.isLinkReady(args.dst)) {
      await client.openLink(args.dst, { controllerName: NAME, protocolVersion: 1, appVersion: '0.0.0-smoke' });
    }
    return client.invoke(args.dst, { channel: SHARED_DATASETS_CHANNEL, args: [args.request] });
  },
  /** Runs the real dispatcher for a logical cross-account peer (provider-share guest). */
  async runAsGuest() {
    const src = providerShareGuestPeer('share-1', 'member-1', 'guest-device');
    return runInvoke(src, { channel: SHARED_DATASETS_CHANNEL, args: [{ action: 'caps' }] });
  },
  async revoke(args: { deviceId: string; revoked: boolean }) {
    await updateDeviceLinkSetting('revokedControllers', (current: string[]) =>
      args.revoked ? [...new Set([...current, args.deviceId])] : current.filter((id) => id !== args.deviceId),
    );
    return readDeviceLinkSettings().revokedControllers;
  },
  async quit() {
    client.stop();
    setTimeout(() => process.exit(0), 50);
    return {};
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg: { id: number; cmd: string; args?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void (async () => {
    try {
      const result = await commands[msg.cmd]?.(msg.args ?? {});
      process.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id: msg.id, ok: false, error: String((error as Error)?.stack ?? error).slice(0, 800) })}\n`);
    }
  })();
});
process.stdin.on('end', () => process.exit(0));

client.start();
process.stdout.write(`${JSON.stringify({ ready: true, deviceId: DEVICE_ID })}\n`);
