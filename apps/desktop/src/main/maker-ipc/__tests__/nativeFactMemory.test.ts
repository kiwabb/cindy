/**
 * Production entry: opt-in native send/terminal composition. Rule: failed or cancelled turns
 * must not become user facts; existing transaction tests have no fact binding.
 * Minimal failure: late success for a replaced Session/generation. Tier: unit, explicit queue fixture.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FactMemoryQueue } from '@cindy/maker-core';
import { bindNativeFactMemory, withNativeFactMemoryTurn, finishNativeFactMemoryTurn } from '../nativeFactMemory.js';
const source = { logicalTurnId: 'turn-fixture', userMessageId: 'message-fixture', userText: 'fixture only', origin: 'user' as const };
function setup() {
  const session = { id: 'fixture-session', instanceId: 'fixture-instance', remoteHostId: null };
  const queue = { prepare: vi.fn(() => ({ generation: 1 })), finish: vi.fn(), drain: vi.fn(async () => {}), dispose: vi.fn() };
  const errors = vi.fn();
  const dispose = bindNativeFactMemory(session, queue as unknown as FactMemoryQueue, () => {}, errors);
  return { session, queue, dispose, errors };
}
describe('native fact binding, fixture queue', () => {
  it('leaves unbound sends unchanged and accepts completion only for the bound instance/generation', async () => {
    const { session, queue, dispose } = setup();
    const replacement = { ...session, instanceId: 'replacement' };
    await withNativeFactMemoryTurn(replacement, source, async reserved => { expect(reserved).toBeUndefined(); return { accepted: true }; });
    await withNativeFactMemoryTurn(session, source, async reserved => { reserved?.(1); return { accepted: true }; });
    finishNativeFactMemoryTurn(replacement, 1, 'completed');
    finishNativeFactMemoryTurn(session, 2, 'completed');
    expect(queue.finish).not.toHaveBeenCalled();
    finishNativeFactMemoryTurn(session, 1, 'completed');
    finishNativeFactMemoryTurn(session, 1, 'completed');
    expect(queue.finish).toHaveBeenCalledTimes(1);
    expect(queue.drain).toHaveBeenCalledTimes(1);
    dispose(); expect(queue.dispose).toHaveBeenCalledOnce();
  });
  it('discards undispatched and failed turns without draining analysis', async () => {
    const { session, queue, dispose } = setup();
    await withNativeFactMemoryTurn(session, source, async reserved => { reserved?.(1); return { accepted: false, reason: 'cancelled-before-dispatch' }; });
    expect(queue.finish).toHaveBeenCalledWith({ generation: 1 }, 'failed', 1);
    expect(queue.drain).not.toHaveBeenCalled(); dispose();
  });
  it('does not turn fact preparation failure into a broken native send', async () => {
    const { session, queue, dispose, errors } = setup();
    queue.prepare.mockImplementation(() => { throw new Error('fixture scope change'); });
    const result = await withNativeFactMemoryTurn(session, source, async reserved => { reserved?.(1); return { accepted: true }; });
    expect(result.accepted).toBe(true); expect(errors).toHaveBeenCalledOnce();
    finishNativeFactMemoryTurn(session, 1, 'completed');
    expect(queue.drain).not.toHaveBeenCalled(); dispose();
  });
  it('ignores non-owner input and a late terminal after dispose', async () => {
    const { session, queue, dispose } = setup();
    await withNativeFactMemoryTurn(session, undefined, async reserved => { expect(reserved).toBeUndefined(); return { accepted: true }; });
    expect(queue.prepare).not.toHaveBeenCalled(); dispose();
    finishNativeFactMemoryTurn(session, 1, 'completed'); expect(queue.finish).not.toHaveBeenCalled();
  });
});
