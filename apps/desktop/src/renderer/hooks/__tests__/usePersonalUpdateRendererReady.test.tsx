// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePersonalUpdateRendererReady } from '../usePersonalUpdateRendererReady';

afterEach(() => { vi.unstubAllGlobals(); });

it('signals through the existing API only after two committed frames and cancels an unmounted shell', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const acknowledge = vi.fn(async () => ({ ok: true }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { appReadyForBot: acknowledge } });
  const nextFrame = () => {
    const entries = [...frames.entries()]; frames.clear();
    act(() => { for (const [, callback] of entries) callback(0); });
  };
  const shell = renderHook(() => usePersonalUpdateRendererReady('fixture-owner', 1));
  expect(acknowledge).not.toHaveBeenCalled();
  nextFrame(); expect(acknowledge).not.toHaveBeenCalled();
  nextFrame(); expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ rendererCommitted: true, dataOwnerId: 'fixture-owner', ownerGeneration: 1 });
  shell.unmount();
  acknowledge.mockClear();
  const interrupted = renderHook(() => usePersonalUpdateRendererReady('fixture-owner', 1));
  nextFrame(); interrupted.unmount(); nextFrame();
  expect(acknowledge).not.toHaveBeenCalled();
  const switching = renderHook(({ owner, generation }) => usePersonalUpdateRendererReady(owner, generation),
    { initialProps: { owner: 'owner-a', generation: 1 } });
  nextFrame(); switching.rerender({ owner: 'owner-b', generation: 2 });
  nextFrame(); expect(acknowledge).not.toHaveBeenCalled();
  nextFrame(); expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ rendererCommitted: true, dataOwnerId: 'owner-b', ownerGeneration: 2 });
  switching.unmount();
});
