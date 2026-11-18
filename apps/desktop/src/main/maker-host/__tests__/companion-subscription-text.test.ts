// Mock utility transport; verifies exact production adapter options, no credentials or HTTP.
import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestExplicitUtilityText: request,
}));
import { requestCompanionSubscriptionText } from '../companion-subscription-text.js';
it('pins one OpenAI model and checks lifetime at the actual dispatch boundary', async () => {
  let current = true;
  const guard = () => {
    if (!current) throw Error('STALE');
  };
  request.mockImplementation(async (_prompt, opts) => {
    expect(opts).toMatchObject({ providerId: 'openai', agentKind: 'codex', model: 'fixture' });
    current = false;
    await opts.beforeDispatch({ providerId: 'openai', agentKind: 'codex', model: 'fixture' });
    throw Error('must not dispatch');
  });
  await expect(
    requestCompanionSubscriptionText({ model: 'fixture', prompt: 'fixture', assertCurrent: guard }),
  ).rejects.toThrow('STALE');
});
it('rejects a dispatch or receipt from a different source/model instead of accepting a fallback', async () => {
  request.mockImplementation(async (_p, opts) => {
    await opts.beforeDispatch({ providerId: 'xd', agentKind: 'codex', model: 'fixture' });
    throw Error('must not dispatch');
  });
  await expect(
    requestCompanionSubscriptionText({ model: 'fixture', prompt: 'fixture', assertCurrent() {} }),
  ).rejects.toThrow('ROUTE_CHANGED');
  request.mockResolvedValue({ ok: true, providerId: 'openai', model: 'other', text: '[]' });
  await expect(
    requestCompanionSubscriptionText({ model: 'fixture', prompt: 'fixture', assertCurrent() {} }),
  ).rejects.toThrow('UNAVAILABLE');
});
