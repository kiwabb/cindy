/** Unit fixtures only: fake fetch, no socket or model invocation. */
import { it, expect, vi } from 'vitest';
import { createFactResponsesPort } from '../fact-analysis-responses.js';
const route = { providerId: 'fixture-user-provider', model: 'fixture-model', protocol: 'openai-responses' as const, baseUrl: 'http://127.0.0.1:1/v1' };
const input = () => ({ route, userText: 'fixture human text', facts: [], signal: new AbortController().signal });
function fixture() {
  const assertCurrent = vi.fn();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ model: route.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '[{"action":"NOOP"}]' }] }] })));
  const resolve = vi.fn(async () => ({ route, headers: { authorization: 'fixture-only' }, assertCurrent }));
  const beforeDispatch = vi.fn();
  return { fetch, resolve, assertCurrent, beforeDispatch, port: createFactResponsesPort(route, { fetch: fetch as typeof globalThis.fetch, resolve, beforeDispatch }) };
}
it('uses one explicit Responses request without fallback or tools', async () => {
  const f = fixture(); expect((await f.port.analyze(input())).changes).toEqual([{ action: 'NOOP' }]);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.beforeDispatch).toHaveBeenCalledOnce();
  const [url, init] = (f.fetch.mock.calls as unknown as [string, RequestInit][])[0];
  expect(url).toBe('http://127.0.0.1:1/v1/responses'); expect(init.redirect).toBe('error');
  const body = JSON.parse(init.body as string);
  expect(body).toMatchObject({ model: route.model, tools: [], tool_choice: 'none', stream: false, store: false });
  expect(JSON.parse(body.input[0].content[0].text).userText).toBe('fixture human text');
});
it('rejects changed route, stale owner and cancellation before network', async () => {
  const f = fixture();
  await expect(f.port.analyze({ ...input(), route: { ...route, model: 'foreign' } })).rejects.toThrow('FACT_ROUTE_CHANGED');
  f.assertCurrent.mockImplementation(() => { throw Error('fixture stale owner'); });
  await expect(f.port.analyze(input())).rejects.toThrow('stale owner');
  f.assertCurrent.mockReset(); const abort = new AbortController(); abort.abort();
  await expect(f.port.analyze({ ...input(), signal: abort.signal })).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});
it('does not retry errors or expose upstream bodies and rejects wrong model/incomplete output', async () => {
  const f = fixture(); f.fetch.mockResolvedValueOnce(new Response('private upstream fixture', { status: 429 }));
  await expect(f.port.analyze(input())).rejects.toThrow(/^FACT_HTTP_429$/); expect(f.fetch).toHaveBeenCalledOnce();
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ model: 'wrong', status: 'completed', output: [] })));
  await expect(f.port.analyze(input())).rejects.toThrow('FACT_RESPONSE_NOT_COMPLETED');
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ model: route.model, status: 'incomplete', output: [] })));
  await expect(f.port.analyze(input())).rejects.toThrow('FACT_RESPONSE_NOT_COMPLETED');
});
it('bounds buffering and rejects scope changes after dispatch', async () => {
  const f = fixture(); f.fetch.mockResolvedValueOnce(new Response('x'.repeat(262145)));
  await expect(f.port.analyze(input())).rejects.toThrow('FACT_RESPONSE_TOO_LARGE');
  f.fetch.mockImplementationOnce(async () => { f.assertCurrent.mockImplementation(() => { throw Error('scope changed'); }); return new Response('{}'); });
  await expect(f.port.analyze(input())).rejects.toThrow('scope changed');
});
