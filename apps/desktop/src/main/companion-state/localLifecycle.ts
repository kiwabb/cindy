import type { Session } from '@cindy/maker-core';
import { companionHomes } from '../companion-cloud/homes.js';
import { createDesktopResponsesTextPort } from '../maker-host/fact-analysis-responses.desktop.js';
import { activateCompanionState } from './service.js';
import type { ExplicitModel } from './types.js';

/** Explicit local-dialogue binding. This factory never grants autonomous execution authority. */
export function createLocalCompanionState(input: {
  ownerId: string; ownerEpoch: string; botId: string; deviceId: string; session: Session; route: ExplicitModel;
  assertCurrent(): void; reportFailure(): void;
}) {
  const current = () => {
    input.assertCurrent();
    // Negative evidence remains binding even offline. Unknown cloud state is NOT a send grant.
    const view = companionHomes.snapshot();
    const home = view.actors.find(actor => actor.externalId === input.botId)?.homeDeviceId;
    if (view.demotedBotIds.includes(input.botId) || home && home !== view.selfDeviceId)
      throw new Error('COMPANION_LOCAL_COPY_REVOKED');
  };
  current();
  const service = activateCompanionState({ enabled: true,
    ownerId: input.ownerId, ownerEpoch: input.ownerEpoch, botId: input.botId,
    session: input.session, route: input.route, deviceId: input.deviceId,
    responses: createDesktopResponsesTextPort(input.session.id, input.route, current),
    assertCurrent: current, reportFailure: input.reportFailure,
    // Stable identity isolates this binding; without an executor port it grants no autonomous sends.
  })!;
  let disposed = false, unsubscribe = () => {};
  const dispose = () => { if (disposed) return; disposed = true; unsubscribe(); service.dispose(); };
  unsubscribe = companionHomes.onChange(() => { try { current(); } catch { dispose(); } });
  return { dispose, prepareContribution: service.prepareContribution };
}
