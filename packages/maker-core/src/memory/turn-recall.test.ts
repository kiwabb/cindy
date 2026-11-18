import { it, expect, vi } from 'vitest';
import { searchTurnMemories } from './turn-context.js';
const hit = { filename: 'reference_alpha.md', title: 'alpha', snippet: 'fixture', score: 1, type: 'reference' as const };
it('recalls a named item from a full question after strict FTS misses, without model calls', async () => {
  const search = vi.fn(async (q: string) => q === 'a1alpha' ? [hit] : []);
  expect(await searchTurnMemories({ search }, '【A1实测】a1alpha 验证代号是什么？', new AbortController().signal)).toEqual([hit]);
  expect(search.mock.calls.map(x => x[0])).toContain('a1alpha');
  expect(search.mock.calls.length).toBeLessThanOrEqual(4);
});
it('keeps successful full-query ranking without fallback', async () => {
  const search = vi.fn(async () => [hit]);
  expect(await searchTurnMemories({ search }, 'known question', new AbortController().signal)).toEqual([hit]);
  expect(search).toHaveBeenCalledTimes(1);
});
it('does not continue fallback queries after cancellation', async () => {
  const abort = new AbortController(); const search = vi.fn(async () => { abort.abort(new Error('cancelled')); return []; });
  await expect(searchTurnMemories({ search }, 'a1alpha question', abort.signal)).rejects.toThrow('cancelled');
  expect(search).toHaveBeenCalledTimes(1);
});
it('hydrates a title-only FTS hit from the scoped body before preparing hidden context', async () => {
  const { MemoryTurnContext } = await import('./turn-context.js');
  const { HOST_TURN_CONTEXT } = await import('../agents/shared/host-turn-context.js');
  const memory = { search: vi.fn(async () => [hit]), read: vi.fn(async () => ({ body: 'actual stored test fact' })) };
  const controller = new MemoryTurnContext({ scope: 'unit', memory,
    receipts: { get: async () => null, commitOnce: async () => {} }, assertCurrent: () => {} });
  const prepared = await controller.prepare({ onEvent: () => () => {}, onStatusChange: () => () => {} },
    'body-hydration', { identity: 'question', query: 'alpha' });
  if ('kind' in prepared) throw Error('unexpected dedupe');
  expect(memory.read).toHaveBeenCalledWith(hit.filename);
  expect(prepared.augment({})[HOST_TURN_CONTEXT]?.text).toContain('actual stored test fact');
  prepared.cancel();
});
