import { SHARED_DATASETS_CHANNEL, type SharedDatasetsChangedPush, type SharedDatasetsRequest } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, onAppSessionInvalidated, ownerScopedUserDataPath } from '../appSessionState.js';
import { isDesktopPlatform } from '../device-link/controllerPlatform.js';
import { setSharedDatasetsRemoteHandler } from '../device-link/dispatch.desktop.js';
import {
  getControllerName,
  getSelfDeviceId,
  isDevicePresenceOnline,
  listSharedDatasetsPushTargets,
  onDesktopPeerOnline,
  onPeerPresenceChanged,
  remoteBackgroundInvoke,
  sendSharedDatasetsChanged,
  setSharedDatasetsPushReceiver,
} from '../device-link/index.js';
import { defaultDeps as deviceDirectoryDeps, handleListDevices } from '../device-link/ipc.js';
import { createLogger } from '../logger.js';
import { installSharedDatasetsEngine } from './api.js';
import { createSharedDatasetsEngine, SYNC_FALLBACK_MS } from './engine.js';
import { sharedDatasetRegistry } from './registry.js';
import type { SharedDatasetsPorts } from './types.js';

const log = createLogger('shared-datasets');

function realPorts(): SharedDatasetsPorts {
  return {
    selfDeviceId: () => getSelfDeviceId(),
    captureScope: () => {
      if (isAppSessionBoundaryPending()) throw new Error('app session boundary pending');
      const owner = activeOwnerScopeKey();
      return {
        owner,
        baseDir: ownerScopedUserDataPath('shared-datasets'),
        assertCurrent: () => {
          if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) {
            throw new Error('shared dataset owner changed');
          }
        },
      };
    },
    listPeers: async () => {
      const { devices } = await handleListDevices(deviceDirectoryDeps());
      return devices
        .filter((device) => !device.isSelf && isDesktopPlatform(device.platform))
        .map((device) => ({ deviceId: device.deviceId, name: device.name, online: device.online }));
    },
    isPeerOnline: (deviceId) => isDevicePresenceOnline(deviceId),
    peerName: (deviceId) => getControllerName(deviceId),
    invoke: (deviceId, request: SharedDatasetsRequest) =>
      remoteBackgroundInvoke(deviceId, SHARED_DATASETS_CHANNEL, [request]),
    sendChanged: (deviceId, frame: SharedDatasetsChangedPush) => sendSharedDatasetsChanged(deviceId, frame),
    pushTargets: () => listSharedDatasetsPushTargets(),
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    log: { warn: (message, meta) => log.warn(message, meta) },
  };
}

/**
 * Wires the engine into Device Link. Inert until a dataset is registered and its role is not
 * `off`: no timers, no requests, only a handler that answers `caps`/`not home`.
 */
export function startSharedDatasets(): () => void {
  const engine = createSharedDatasetsEngine(realPorts(), sharedDatasetRegistry);
  installSharedDatasetsEngine(engine);
  setSharedDatasetsRemoteHandler({ handle: (src, arg) => engine.handleRequest(src, arg) });
  setSharedDatasetsPushReceiver((src, payload) => engine.handleChangedPush(src, payload));
  const offPeer = onDesktopPeerOnline((deviceId) => engine.onPeerOnline(deviceId));
  const offPresence = onPeerPresenceChanged((deviceId) => engine.onPeerPresence(deviceId));
  const offSession = onAppSessionInvalidated(() => engine.suspend());
  void engine.resume().catch(() => undefined);
  // Picks the new account up after a switch (presence events usually get there first).
  const interval = setInterval(() => void engine.resume().catch(() => undefined), SYNC_FALLBACK_MS);
  interval.unref?.();
  return () => {
    clearInterval(interval);
    offPeer();
    offPresence();
    offSession();
    setSharedDatasetsPushReceiver(null);
    setSharedDatasetsRemoteHandler(null);
    installSharedDatasetsEngine(null);
    engine.stop();
  };
}
