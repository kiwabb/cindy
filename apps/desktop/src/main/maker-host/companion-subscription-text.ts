import { requestExplicitUtilityText } from '../utility-model/oneShotCandidates.js';

/** Exact user-selected OpenAI subscription. Never enters the auxiliary/default candidate chain. */
export async function requestCompanionSubscriptionText(input: {
  model: string;
  prompt: string;
  assertCurrent(): void;
  signal?: AbortSignal;
}) {
  if (!input.model || typeof input.prompt !== 'string' || input.prompt.length > 131072)
    throw Error('COMPANION_ANALYSIS_INPUT_INVALID');
  input.assertCurrent();
  input.signal?.throwIfAborted();
  const result = await requestExplicitUtilityText(input.prompt, {
    providerId: 'openai',
    agentKind: 'codex',
    model: input.model,
    signal: input.signal,
    timeoutMs: 60_000,
    maxTokens: 4096,
    beforeDispatch: async (route) => {
      input.assertCurrent();
      input.signal?.throwIfAborted();
      if (
        route.providerId !== 'openai' ||
        route.agentKind !== 'codex' ||
        route.model !== input.model
      )
        throw Error('COMPANION_SUBSCRIPTION_ROUTE_CHANGED');
      return true;
    },
  });
  input.assertCurrent();
  input.signal?.throwIfAborted();
  if (!result.ok || result.providerId !== 'openai' || result.model !== input.model)
    throw Error('COMPANION_SUBSCRIPTION_UNAVAILABLE');
  return { providerId: result.providerId, model: result.model, text: result.text };
}
