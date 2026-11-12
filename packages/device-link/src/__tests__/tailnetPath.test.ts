import { describe, expect, it, vi } from 'vitest';
import type { DirectRuntime, DirectRuntimeEvents } from '../directNegotiation.js';
import { parseTailscaleStatus, withTailnetCandidatePolicy, type TailnetStatus } from '../tailnetPath.js';

// Protects the V1 direct-link candidate policy (device-link-lan-first-direct.md「Tailscale 候选策略」):
// a DERP-only tailnet address must never be the data path (P0 2026-11-12: ~440 ms vs relay ~80 ms), LAN
// candidates and LANs that merely use 100.64/10 stay untouched, and with no readable Tailscale nothing
// happens at all. Tier: unit, in-process fakes.
const cand = (ip: string, n = 1) => `a=candidate:${n} 1 udp 2122260223 ${ip} 5000${n} typ host generation 0\r\n`;
const sdp = (...ips: string[]) => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n${ips.map((ip, i) => cand(ip, i + 1)).join('')}a=end-of-candidates\r\n`;
const lines = (text: string) => text.split('\r\n').filter((l) => l.startsWith('a=candidate:')).map((l) => l.split(' ')[4]);

const LAN = '172.30.96.5', TAIL = '100.101.1.2', TAIL6 = 'fd7a:115c:a1e0::1234', SELF = '100.101.1.1';
const mk = (peers: { ips: string[]; direct: boolean }[]): TailnetStatus => ({ known: new Set([SELF, ...peers.flatMap((p) => p.ips)]), peers });
const direct = mk([{ ips: [TAIL], direct: true }]);
const derpOnly = mk([{ ips: [TAIL, 'fd7a:115c:a1e0:0:0:0:0:1234'], direct: false }]);

type Policy = { wrapped: DirectRuntime; next: { inner?: DirectSession; capture?(e: DirectRuntimeEvents): void } };
type DirectSession = ReturnType<DirectRuntime['create']>;
function policy(status: TailnetStatus | null | 'hang', now?: () => number): Policy {
  const next: Policy['next'] = {};
  const runtime: DirectRuntime = { create: (_id, e) => { next.capture?.(e); return next.inner!; } };
  const wrapped = withTailnetCandidatePolicy(runtime, () => status === 'hang' ? new Promise(() => {}) : Promise.resolve(status),
    { waitMs: 20, ...(now ? { now } : {}) });
  return { wrapped, next };
}
// `shared` lets several sessions go through one policy instance (cooldown state), each with its own fake runtime session.
function harness(status: TailnetStatus | null | 'hang', outgoing = sdp(LAN, SELF), options: { peer?: string; now?(): number } = {}, shared?: Policy) {
  const received: string[] = [];
  const delivered: string[] = [];
  let events!: DirectRuntimeEvents;
  const inner = { close: vi.fn(() => events.closed('channel-closed')), bufferedAmount: 0, send() {}, offer: async () => outgoing,
    accept: async (s: string) => { received.push(s); return outgoing; }, answer: async (s: string) => { received.push(s); } };
  const p = shared ?? policy(status, options.now);
  p.next.inner = inner;
  p.next.capture = (e) => { events = e; };
  const open = vi.fn(), closed = vi.fn();
  const session = p.wrapped.create('x', { open, closed, message: (t) => delivered.push(t), drained() {} }, options.peer ? { kind: 'device', peer: options.peer } : undefined);
  return { session, received, delivered, inner, open, closed, events: () => events, policy: p };
}

describe('withTailnetCandidatePolicy SDP filtering', () => {
  it.each([
    ['keeps LAN and strips DERP-only tailnet candidates (v4 and v6 spelled differently)', derpOnly, [LAN, TAIL, TAIL6], [LAN]],
    ['keeps a tailnet candidate whose owner is direct, LAN unchanged', direct, [LAN, TAIL], [LAN, TAIL]],
    ['does nothing when Tailscale is not running or readable', null, [LAN, TAIL], [LAN, TAIL]],
    ['does nothing when the CLI does not answer in time', 'hang', [LAN, TAIL], [LAN, TAIL]],
    ['leaves a LAN that merely uses 100.64/10 alone (not reported by Tailscale)', derpOnly, ['100.70.0.9', 'fd7a:115c:a1e0::9', LAN], ['100.70.0.9', 'fd7a:115c:a1e0::9', LAN]],
    ['ignores mDNS names and non-tailnet 100.x', derpOnly, ['100.63.0.1', '100.128.0.1', 'abc.local'], ['100.63.0.1', '100.128.0.1', 'abc.local']],
  ] as const)('incoming offer: %s', async (_name, status, ips, kept) => {
    const h = harness(status as TailnetStatus | null | 'hang');
    await h.session.accept(sdp(...ips));
    expect(lines(h.received[0]!)).toEqual(kept);
    expect(h.received[0]).toContain('c=IN IP4 0.0.0.0\r\n'); // untouched elsewhere, CRLF kept
  });

  it('an answer reveals own tailnet candidates only when that remote was approved', async () => {
    expect(lines(await harness(direct).session.accept(sdp(LAN, TAIL)))).toEqual([LAN, SELF]);
    expect(lines(await harness(derpOnly).session.accept(sdp(LAN, TAIL)))).toEqual([LAN]);
    expect(lines(await harness(direct).session.accept(sdp(LAN)))).toEqual([LAN]);
  });

  it('an offer always includes own tailnet candidates (other peers say nothing about the remote); the answer decides', async () => {
    expect(lines(await harness(derpOnly).session.offer())).toEqual([LAN, SELF]);
    expect(lines(await harness(direct).session.offer())).toEqual([LAN, SELF]);
    expect(lines(await harness(null).session.offer())).toEqual([LAN, SELF]);
  });
});

describe('withTailnetCandidatePolicy unapproved tailnet pair', () => {
  it('closes it before the reliable layer sees it, with its own reason and a per-peer cooldown that strips both sides', async () => {
    let now = 1_000;
    const first = harness(derpOnly, sdp(LAN, SELF), { peer: 'p1', now: () => now });
    await first.session.offer(); await first.session.answer(sdp(LAN, TAIL));
    first.events().open({ tailnetAddresses: [TAIL] });
    first.events().message('early'); // arrives while the decision is pending: held, then dropped with the channel
    await vi.waitFor(() => expect(first.inner.close).toHaveBeenCalledOnce());
    expect(first.open).not.toHaveBeenCalled();
    expect(first.delivered).toEqual([]);
    expect(first.closed).toHaveBeenCalledExactlyOnceWith('tailnet-unapproved');
    // Same peer inside the cooldown: tailnet candidates stripped on both sides.
    const retry = harness(direct, sdp(LAN, SELF), { peer: 'p1', now: () => now }, first.policy);
    expect(lines(await retry.session.accept(sdp(LAN, TAIL)))).toEqual([LAN]);
    expect(lines(retry.received[0]!)).toEqual([LAN]);
    expect(lines(await retry.session.offer())).toEqual([LAN]);
    // Another peer is unaffected; after the cooldown the same peer may use tailnet again.
    expect(lines(await harness(direct, sdp(LAN, SELF), { peer: 'p2', now: () => now }, first.policy).session.offer())).toEqual([LAN, SELF]);
    now += 10 * 60_000 + 1;
    expect(lines(await harness(direct, sdp(LAN, SELF), { peer: 'p1', now: () => now }, first.policy).session.offer())).toEqual([LAN, SELF]);
  });

  it('forwards an approved tailnet pair with the label and delivers held frames in order after open', async () => {
    const h = harness(direct);
    await h.session.offer(); await h.session.answer(sdp(LAN, TAIL));
    h.events().open({ tailnetAddresses: [SELF, TAIL] });
    h.events().message('one'); h.events().message('two');
    await vi.waitFor(() => expect(h.open).toHaveBeenCalledExactlyOnceWith({ viaTailnet: true }));
    expect(h.delivered).toEqual(['one', 'two']);
  });

  it('never closes a LAN pair, including a 100.64/10 LAN or unreadable Tailscale', async () => {
    const lan = harness(derpOnly);
    lan.events().open();
    expect(lan.open).toHaveBeenCalledExactlyOnceWith();
    const cgnat = harness(derpOnly);
    cgnat.events().open({ tailnetAddresses: ['100.70.0.9'] });
    await vi.waitFor(() => expect(cgnat.open).toHaveBeenCalledExactlyOnceWith());
    const unreadable = harness(null);
    unreadable.events().open({ tailnetAddresses: [TAIL] });
    await vi.waitFor(() => expect(unreadable.open).toHaveBeenCalledExactlyOnceWith());
    expect(cgnat.inner.close).not.toHaveBeenCalled();
    expect(unreadable.inner.close).not.toHaveBeenCalled();
  });
});

describe('parseTailscaleStatus', () => {
  const self = { TailscaleIPs: ['100.90.0.1'] };
  it('marks a peer direct only with a non-empty CurAddr and not offline; known = every reported address', () => {
    const status = parseTailscaleStatus({ BackendState: 'Running', Self: self, Peer: {
      a: { TailscaleIPs: ['100.90.0.2', 'FD7A:115C:A1E0::2'], CurAddr: '1.2.3.4:41641', Online: true },
      b: { TailscaleIPs: ['100.90.0.3'], CurAddr: '', Relay: 'sfo', Online: true },
      c: { TailscaleIPs: ['100.90.0.4'], CurAddr: '1.2.3.4:1', Online: false },
    } });
    expect(status?.peers.map((p) => p.direct)).toEqual([true, false, false]);
    expect([...status!.known].sort()).toEqual(['100.90.0.1', '100.90.0.2', '100.90.0.3', '100.90.0.4', 'fd7a:115c:a1e0:0:0:0:0:2']);
  });
  it.each([
    ['not logged in', { BackendState: 'NeedsLogin', Self: self }],
    ['no self addresses', { BackendState: 'Running', Self: {} }],
    ['garbage', 'x'],
  ])('is unusable when %s', (_n, json) => { expect(parseTailscaleStatus(json)).toBeNull(); });
  it('accepts a tailnet with no peers', () => {
    expect(parseTailscaleStatus({ Self: self, Peer: null })?.peers).toEqual([]);
  });
});
