import type { FactRoute } from '@cindy/maker-core';
import { createFactResponsesPort, createResponsesTextPort, type FactResponsesDeps } from './fact-analysis-responses.js';
import { getSessionProvider } from './session-provider-store.js';
import { getProviderRoutingDescriptor, getProviderRouteCredentialRevision, isProviderRouteMutationInProgress,
  resolveSessionRoute, buildLocalHandlerHeaders } from './provider-route.js';
import { getActiveCatalog } from './active-catalog.js';
import { outboundFetch } from './outbound-fetch.desktop.js';

/** Uses the host's selected connection/credential resolver; never reads another app's key. */
function desktopResponsesDeps(sessionId: string, route: FactRoute, assertCurrent: () => void): FactResponsesDeps {
  return { fetch: outboundFetch, resolve: async () => {
    assertCurrent();
    if (route.protocol !== 'openai-responses' || !route.baseUrl) throw Error('FACT_HTTP_ROUTE_REQUIRED');
    if (getSessionProvider(sessionId) !== route.providerId) throw new Error('FACT_PROVIDER_CHANGED');
    const provider = getActiveCatalog().providers.find(candidate => candidate.id === route.providerId);
    if (provider?.source !== 'user') throw new Error('FACT_USER_CONNECTION_REQUIRED');
    const routing = getProviderRoutingDescriptor(route.providerId, 'codex', route.model);
    if (!routing || routing.disabled || (routing.wireProtocol ?? 'openai-responses') !== 'openai-responses'
      || routing.authStrategy !== 'api-key-header' || routing.upstream.replace(/\/$/, '') !== route.baseUrl.replace(/\/$/, '')
      || (routing.modelInterface && routing.modelInterface.wireModelId !== route.model)
      || routing.modelIdRewrite?.stripPrefix || routing.requestPath) throw new Error('FACT_EXPLICIT_RESPONSES_ROUTE_REQUIRED');
    const routingSnapshot = JSON.stringify(routing);
    const revision = getProviderRouteCredentialRevision(route.providerId);
    const resolved = await resolveSessionRoute(sessionId, 'codex', route.model);
    assertCurrent();
    if (!resolved || resolved.providerSource !== 'user' || resolved.providerId !== route.providerId
      || !resolved.apiKey || resolved.routing.authStrategy !== 'api-key-header'
      || resolved.routing.upstream !== routing.upstream || resolved.routing.wireProtocol !== routing.wireProtocol) throw new Error('FACT_USER_CONNECTION_REQUIRED');
    const check = () => {
      assertCurrent();
      const liveRouting = getProviderRoutingDescriptor(route.providerId, 'codex', route.model);
      if (JSON.stringify(liveRouting) !== routingSnapshot) throw new Error('FACT_ROUTE_CHANGED');
      if (getSessionProvider(sessionId) !== route.providerId || isProviderRouteMutationInProgress(route.providerId)
        || getProviderRouteCredentialRevision(route.providerId) !== revision) throw new Error('FACT_ROUTE_CHANGED');
    };
    check();
    return { route, headers: buildLocalHandlerHeaders(resolved, 'codex').headers, assertCurrent: check };
  } };
}
export function createDesktopFactResponsesPort(sessionId: string, route: FactRoute, assertCurrent: () => void) {
  const selected = Object.freeze({ ...route });
  return createFactResponsesPort(selected, desktopResponsesDeps(sessionId, selected, assertCurrent));
}
export function createDesktopResponsesTextPort(sessionId: string, route: FactRoute, assertCurrent: () => void) {
  const selected = Object.freeze({ ...route });
  return createResponsesTextPort(selected, desktopResponsesDeps(sessionId, selected, assertCurrent));
}
