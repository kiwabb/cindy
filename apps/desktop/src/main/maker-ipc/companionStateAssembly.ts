import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FactRoute, Session } from '@cindy/maker-core';
import { companionHomes } from '../companion-cloud/homes.js';
import { activateCompanionState } from '../companion-state/service.js';
import { createDesktopResponsesTextPort } from '../maker-host/fact-analysis-responses.desktop.js';

/** A local binding ID is not a relay/home device ID. Profile separation is deliberate.
 * Existing ledger/outbox identities are never rewritten or inferred to be equivalent. */
export function localCompanionBindingId(profile: string, stableDeviceId: string): string {
  if (!path.isAbsolute(profile) || !stableDeviceId.trim()) throw Error('COMPANION_LOCAL_IDENTITY_REQUIRED');
  return 'local-v1:' + createHash('sha256').update(JSON.stringify([path.resolve(profile), stableDeviceId])).digest('hex');
}
/** Main-only authority, supplied by a future owner-bound fresh executor/lease service.
 * A cached home entry, absence of a remote home or a renderer boolean is not authority. */
export interface CompanionExecutorAuthority {
  readonly scope: { ownerId: string; ownerEpoch: string; botId: string; deviceId: string };
  /** Synchronous fresh-lease/revocation fence, checked at every context and transport boundary. */
  assertBound(): void;
  assertCurrent(): Promise<void>;
}
export interface CompanionStateAssemblyInput {
  ownerId: string; ownerEpoch: string; botId: string; session: Session; route: FactRoute;
  assertCurrent(): void; reportFailure(): void;
}
/** Builds the real explicit Responses/service connection; no credential resolution or fetch on bind. */
export async function bindDesktopCompanionState(input: CompanionStateAssemblyInput, deps: {
  /** Local binding namespace (profile + existing host identity), never a relay ID. */
  deviceId(): string | null;
  /** Relay identity only, used solely for comparison with cloud homeDeviceId. */
  cloudDeviceId?(): string | null;
  authority?: CompanionExecutorAuthority;
}) {
  const deviceId = deps.deviceId(), authority = deps.authority;
  if (!deviceId) throw Error('COMPANION_DEVICE_ID_REQUIRED');
  if (authority && typeof authority.assertBound !== 'function') throw Error('COMPANION_EXECUTOR_AUTHORITY_UNAVAILABLE');
  const scope = Object.freeze({ ownerId: input.ownerId, ownerEpoch: input.ownerEpoch, botId: input.botId, deviceId });
  for (const key of Object.keys(scope) as Array<keyof typeof scope>)
    if (authority && authority.scope[key] !== scope[key]) throw Error('COMPANION_EXECUTOR_SCOPE_MISMATCH');
  const session = input.session, instanceId = session.instanceId, route = Object.freeze({ ...input.route });
  const assertCurrent = input.assertCurrent;
  let disposed = false;
  const current = () => {
    if (disposed || deps.deviceId() !== deviceId || session.instanceId !== instanceId
      || session.getStatus() !== 'active' || session.remoteHostId || session.agentKind !== 'codex'
      || session.model !== route.model) throw Error('COMPANION_STATE_ASSEMBLY_STALE');
    for (const key of Object.keys(scope) as Array<keyof typeof scope>)
      if (authority && authority.scope[key] !== scope[key]) throw Error('COMPANION_EXECUTOR_SCOPE_MISMATCH');
    authority?.assertBound();
    assertCurrent();
    const home = companionHomes.snapshot();
    const homeDevice = home.actors.find(actor => actor.externalId === input.botId)?.homeDeviceId;
    if (home.demotedBotIds.includes(input.botId) || homeDevice && homeDevice !== deps.cloudDeviceId?.())
      throw Error('COMPANION_LOCAL_COPY_REVOKED');
  };
  const executor = authority ? async () => { current();
    if (!deps.cloudDeviceId?.()) throw Error('COMPANION_EXECUTOR_CLOUD_ID_REQUIRED');
    await authority.assertCurrent(); current();
  } : undefined;
  current();
  if (executor) await executor();
  const responses = createDesktopResponsesTextPort(session.id, route, current);
  const service = activateCompanionState({ enabled: true, ...scope, session, route, responses,
    assertCurrent: current, assertExecutor: executor, reportFailure: input.reportFailure });
  if (!service) throw Error('COMPANION_STATE_BINDING_REQUIRED');
  let unsubscribe = () => {};
  const dispose = () => { if (!disposed) { disposed = true; unsubscribe(); service.dispose(); } };
  unsubscribe = companionHomes.onChange(() => { try { current(); } catch { dispose(); } });
  try { current(); } catch (error) { dispose(); throw error; }
  return {
    dispose,
    identity: Object.freeze({ ...scope, namespace: 'local-profile-v1', sessionId: session.id, instanceId }),
    async readState() { current(); const state = await service.read(); current(); return state; },
    // Main-only service operations; missing authority is rejected by the service before any write.
    enqueue: service.enqueue,
    bindSchedule: service.bindSchedule,
    // Called by the existing root prepare only. Recovery reuses its persisted contribution.
    async contribute(signal: AbortSignal) {
      signal.throwIfAborted(); current();
      const contribution = await service.prepareContribution(signal);
      signal.throwIfAborted(); current();
      return contribution;
    },
  };
}
