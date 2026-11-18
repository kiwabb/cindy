import { validateFactSelection, type FactRoute, type Session } from '@cindy/maker-core';
import { createFactTextPort, type ResponsesTextPort } from './fact-analysis-responses.js';
import { requestCompanionSubscriptionText } from './companion-subscription-text.js';

/** Storage stays on the conversation's computer; only bounded extraction input crosses the existing Agent link. */
export function createCompanionSubscriptionPort(
  session: Session,
  selection: FactRoute,
  assertCurrent: () => void,
) {
  const route = Object.freeze({ ...selection });
  if (route.protocol !== 'cindy-subscription' || route.providerId !== 'openai')
    throw Error('COMPANION_SUBSCRIPTION_REQUIRED');
  const current = () => {
    assertCurrent();
    if (
      session.model !== route.model ||
      (session.agentDeviceId ?? null) !== (route.agentDeviceId ?? null)
    )
      throw Error('COMPANION_SUBSCRIPTION_ROUTE_CHANGED');
  };
  const port: ResponsesTextPort = {
    route,
    async request(input) {
      validateFactSelection(route, input.route);
      current();
      input.signal.throwIfAborted();
      const result = route.agentDeviceId
        ? await session.requestCompanionText(input.prompt)
        : await requestCompanionSubscriptionText({
            model: route.model,
            prompt: input.prompt,
            signal: input.signal,
            assertCurrent: current,
          });
      current();
      input.signal.throwIfAborted();
      if (
        result.providerId !== route.providerId ||
        result.model !== route.model ||
        typeof result.text !== 'string' ||
        result.text.length > 262144
      )
        throw Error('COMPANION_SUBSCRIPTION_RESULT_INVALID');
      return { route, text: result.text };
    },
  };
  return createFactTextPort(port);
}
