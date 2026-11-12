import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTailscaleStatusReader, tailscaleCliCandidates, type TailscaleStatusDeps } from '../tailscaleStatus';

// Protects the "no polling, never respawn" rule of the direct-link tailnet policy: one process per
// 30 s window across concurrent negotiations, failures cached too, read-only args only. Tier: unit.
const json = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.90.0.1'] },
  Peer: { a: { TailscaleIPs: ['100.90.0.2'], CurAddr: '1.2.3.4:5' } } });
function deps(result: 'ok' | 'fail') {
  let now = 0;
  const exec = vi.fn<TailscaleStatusDeps['exec']>((_f, _a, _o, cb) => { if (result === 'ok') cb(null, json); else cb(new Error('x'), ''); });
  const d: TailscaleStatusDeps = { exec, candidates: () => ['tailscale'], exists: () => true, now: () => now };
  return { d, exec, advance: (ms: number) => { now += ms; } };
}

it('shares one status-only process between concurrent callers and caches for 30 s', async () => {
  const { d, exec, advance } = deps('ok');
  const read = createTailscaleStatusReader(d);
  const [a, b] = await Promise.all([read(), read()]);
  expect(a?.peers[0]).toEqual({ ips: ['100.90.0.2'], direct: true });
  expect(b).toBe(a);
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0]![1]).toEqual(['status', '--json']);
  await read(); expect(exec).toHaveBeenCalledOnce();
  advance(30_001); await read(); expect(exec).toHaveBeenCalledTimes(2);
});

it('treats a failing, oversized or missing CLI as unavailable: one process per refresh, no respawn within the window', async () => {
  const failing = deps('fail');
  const read = createTailscaleStatusReader(failing.d);
  expect(await read()).toBeNull(); expect(await read()).toBeNull();
  expect(failing.exec).toHaveBeenCalledOnce();
  const missing = createTailscaleStatusReader({ ...failing.d, candidates: () => ['/nope/tailscale'], exists: () => false });
  expect(await missing()).toBeNull();
  const huge = deps('ok');
  huge.exec.mockImplementation((_f, _a, options, cb) => cb(null, 'x'.repeat(options.maxBuffer + 1)));
  expect(await createTailscaleStatusReader(huge.d)()).toBeNull();
  expect(huge.exec.mock.calls[0]![2].maxBuffer).toBe(4 * 1024 * 1024);
});

it('only looks in absolute install locations on Windows and adds Homebrew paths on macOS', () => {
  const win = tailscaleCliCandidates('win32', { ProgramFiles: path.resolve('/pf'), ProgramW6432: path.resolve('/pf'), PATH: path.resolve('/cwd') });
  expect(win).toEqual([path.join(path.resolve('/pf'), 'Tailscale', 'tailscale.exe')]);
  expect(tailscaleCliCandidates('win32', {})).toEqual([]);
  expect(tailscaleCliCandidates('darwin')).toEqual(expect.arrayContaining(['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']));
});
