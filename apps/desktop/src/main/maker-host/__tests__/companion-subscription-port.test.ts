// Explicit route/lifetime fixtures; no actual subscription request.
import { expect, it, vi } from 'vitest';
const local = vi.hoisted(() => vi.fn());
vi.mock('../companion-subscription-text.js', () => ({ requestCompanionSubscriptionText: local }));
import { createCompanionSubscriptionPort } from '../companion-subscription-port.js';
const device = 'a'.repeat(64),
  model = 'fixture-model';
function fixture(remote = true) {
  const route = {
    providerId: 'openai',
    model,
    protocol: 'cindy-subscription' as const,
    agentDeviceId: remote ? device : null,
  };
  const session: any = {
    agentKind: 'codex',
    model,
    agentDeviceId: route.agentDeviceId,
    requestCompanionText: vi.fn(async () => ({ providerId: 'openai', model, text: '[]' })),
  };
  const current = vi.fn();
  return {
    route,
    session,
    current,
    port: createCompanionSubscriptionPort(session, route, current),
  };
}
it('uses only the selected remote run and returns analysis to the local fact port', async () => {
  local.mockClear();
  const f = fixture();
  const result = await f.port.analyze({
    route: f.route,
    userText: 'fixture',
    facts: [],
    signal: new AbortController().signal,
  });
  expect(result).toEqual({ route: f.route, changes: [] });
  expect(f.session.requestCompanionText).toHaveBeenCalledOnce();
  expect(local).not.toHaveBeenCalled();
});
it('offline remote never falls back to local or another provider', async () => {
  local.mockClear();
  const f = fixture();
  f.session.requestCompanionText.mockRejectedValue(Error('OFFLINE'));
  await expect(
    f.port.analyze({
      route: f.route,
      userText: 'fixture',
      facts: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('OFFLINE');
  expect(local).not.toHaveBeenCalled();
});
it('cancellation and changed device reject late facts', async () => {
  const f = fixture();
  const abort = new AbortController();
  f.session.requestCompanionText.mockImplementation(async () => {
    abort.abort();
    return { providerId: 'openai', model, text: '[]' };
  });
  await expect(
    f.port.analyze({ route: f.route, userText: 'fixture', facts: [], signal: abort.signal }),
  ).rejects.toThrow();
  f.session.agentDeviceId = 'b'.repeat(64);
  await expect(
    f.port.analyze({
      route: f.route,
      userText: 'fixture',
      facts: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('ROUTE_CHANGED');
});
it('local path pins the selected subscription and rejects an unexpected result model', async () => {
  const f = fixture(false);
  f.session.agentKind = 'pi';
  f.session.model = 'different-chat-model';
  local.mockResolvedValue({ providerId: 'openai', model: 'other', text: '[]' });
  await expect(
    f.port.analyze({
      route: f.route,
      userText: 'fixture',
      facts: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('RESULT_INVALID');
  expect(f.session.requestCompanionText).not.toHaveBeenCalled();
});
