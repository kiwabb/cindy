/**
 * Tailnet candidate policy for V1 direct links (Desktop only; docs/dev-rules/protocol-compatibility/
 * device-link-lan-first-direct.md「Tailscale 候选策略」).
 *
 * A Tailscale interface address shows up as an ordinary host candidate, but between two nodes that only
 * reach each other through a DERP relay it is slower than the Cindy relay. A tailnet candidate is therefore
 * kept only when the local Tailscale reports a true direct path (non-empty CurAddr) to the node that owns
 * the address. An address counts as tailnet only if Tailscale itself reports it (Self/Peer TailscaleIPs):
 * a LAN that happens to use 100.64.0.0/10 (CGNAT, NetBird, corporate) is never touched, and when Tailscale is
 * not running or readable the policy does nothing. Pure and electron-free: the CLI reader lives in Desktop main.
 */
import type { DirectRuntime, DirectRuntimeEvents, DirectRuntimeSession } from './directNegotiation.js';

export interface TailnetPeer {
  ips: string[];
  /** Tailscale currently has a direct (non-DERP) path to this node. */
  direct: boolean;
}
export interface TailnetStatus {
  /** Normalized addresses Tailscale itself reports (Self + every Peer): the only addresses treated as tailnet. */
  known: ReadonlySet<string>;
  peers: TailnetPeer[];
}

/** Canonical lowercase 8-group form of an IPv6 literal, or null. */
function expandV6(raw: string): string[] | null {
  const text = raw.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(text) || text.split('::').length > 2) return null;
  const [head = '', tail = ''] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = text.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(Math.max(fill, 0)).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}
function parseV4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}
/** Stable key for comparing the same address written differently; null for non-IP text (mDNS names). */
export function normalizeIp(raw: string): string | null {
  const v4 = parseV4(raw);
  if (v4) return v4.join('.');
  const v6 = expandV6(raw);
  return v6 ? v6.join(':') : null;
}
/**
 * Tailscale's own ranges (100.64.0.0/10, fd7a:115c:a1e0::/48). Only a cheap pre-filter that avoids reading
 * the CLI for SDPs without such addresses; it never decides on its own, because LANs may use 100.64/10 too.
 */
export function isTailnetRangeAddress(raw: string): boolean {
  const v4 = parseV4(raw);
  if (v4) return v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127;
  const v6 = expandV6(raw);
  return !!v6 && v6[0] === 'fd7a' && v6[1] === '115c' && v6[2] === 'a1e0';
}

/** Parses `tailscale status --json`. Null = not usable (not running, logged out, malformed). */
export function parseTailscaleStatus(json: unknown): TailnetStatus | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  if (typeof root.BackendState === 'string' && root.BackendState !== 'Running') return null;
  const self = root.Self as Record<string, unknown> | undefined;
  const ips = (v: unknown): string[] => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map(normalizeIp).filter((x): x is string => x !== null) : [];
  const own = self && typeof self === 'object' ? ips(self.TailscaleIPs) : [];
  if (own.length === 0) return null;
  const known = new Set(own);
  const peers: TailnetPeer[] = [];
  const map = root.Peer;
  if (map && typeof map === 'object') {
    for (const value of Object.values(map as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const p = value as Record<string, unknown>;
      const list = ips(p.TailscaleIPs);
      list.forEach((ip) => known.add(ip));
      peers.push({ ips: list, direct: typeof p.CurAddr === 'string' && p.CurAddr !== '' && p.Online !== false });
    }
  }
  return { known, peers };
}

/** An address is tailnet only if Tailscale itself reports it; a bare 100.64/10 LAN address is not. */
export function isTailnetAddress(status: TailnetStatus, ip: string): boolean {
  const key = normalizeIp(ip);
  return !!key && status.known.has(key);
}
/** True when a Tailscale peer that owns `ip` has a true direct path. */
export function addressIsDirect(status: TailnetStatus, ip: string): boolean {
  const key = normalizeIp(ip);
  return !!key && status.peers.some((p) => p.direct && p.ips.includes(key));
}

const CANDIDATE = /^a=candidate:/;
function candidateAddress(line: string): string | null {
  return CANDIDATE.test(line) ? line.trim().split(/\s+/)[4] ?? null : null;
}
/** Cheap range pre-check on an SDP: nothing to decide (and no CLI read) unless a candidate is in Tailscale's ranges. */
export function hasTailnetRangeCandidate(sdp: string): boolean {
  return sdp.split('\n').some((line) => { const ip = candidateAddress(line); return !!ip && isTailnetRangeAddress(ip); });
}
/** Drops candidate lines where `isTailnet(ip)` and not `keep(ip)`; everything else (LAN, mDNS, other lines, CRLF) is untouched. */
export function filterTailnetCandidates(sdp: string, isTailnet: (ip: string) => boolean, keep: (ip: string) => boolean): { sdp: string; kept: number; stripped: number } {
  let kept = 0;
  let stripped = 0;
  const lines = sdp.split('\n').filter((line) => {
    const ip = candidateAddress(line);
    if (!ip || !isTailnet(ip)) return true;
    if (keep(ip)) { kept += 1; return true; }
    stripped += 1;
    return false;
  });
  return { sdp: stripped ? lines.join('\n') : sdp, kept, stripped };
}

export const TAILNET_STATUS_WAIT_MS = 2_000;
/** After a tailnet pair was closed as unapproved, that peer negotiates without tailnet candidates for this long. */
export const TAILNET_COOLDOWN_MS = 10 * 60_000;

/**
 * Per-session policy around a host runtime (all SDP passes through here, so the renderer-side runtime stays
 * unfiltered). It only acts when Tailscale is running and readable, otherwise it does nothing at all.
 * - Remote SDP (accept/answer): keep a tailnet candidate only if its owner is direct; `approved` = one was kept.
 * - Own SDP: an offer always includes own tailnet candidates (the remote is unknown, and other peers' state says
 *   nothing about it) and the answer decides; an answer reveals them only if `approved`.
 * - Backstop: stripping SDP does not remove our tailnet socket, so a peer that does not filter (old Desktop,
 *   Mobile) could pair over DERP, also peer-reflexively. An open over a tailnet pair that is not approved is
 *   closed before the reliable layer sees it (diagnostic `tailnet-unapproved`), and that peer goes on a cooldown
 *   during which our tailnet candidates and the remote's are stripped so the LAN path can still form.
 */
export function withTailnetCandidatePolicy(
  runtime: DirectRuntime,
  readStatus: () => Promise<TailnetStatus | null>,
  options: { waitMs?: number; cooldownMs?: number; now?(): number;
    diagnostic?(event: 'stripped' | 'kept' | 'blocked-pair', count: number): void } = {},
): DirectRuntime {
  const waitMs = options.waitMs ?? TAILNET_STATUS_WAIT_MS;
  const cooldownMs = options.cooldownMs ?? TAILNET_COOLDOWN_MS;
  const now = options.now ?? (() => Date.now());
  const cooldown = new Map<string, number>();
  const cooling = (peer: string | undefined): boolean => {
    if (!peer) return false;
    const until = cooldown.get(peer);
    if (until === undefined) return false;
    if (now() < until) return true;
    cooldown.delete(peer);
    return false;
  };
  const status = async (): Promise<TailnetStatus | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([readStatus().catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
    } finally { clearTimeout(timer); }
  };
  const note = (event: 'stripped' | 'kept' | 'blocked-pair', count: number) => {
    try { options.diagnostic?.(event, count); } catch { /* Diagnostics never affect negotiation. */ }
  };
  return {
    ...(runtime.capacity ? { capacity: runtime.capacity } : {}),
    ...(runtime.suspend ? { suspend: () => runtime.suspend!() } : {}),
    create(id: string, events: DirectRuntimeEvents, createOptions): DirectRuntimeSession {
      const peer = createOptions?.peer;
      let approved = false;
      let finished = false;
      let blocked = false;
      let openPending = false;
      let held: string[] = [];
      let session: DirectRuntimeSession;
      const block = () => {
        if (blocked) return;
        blocked = true;
        if (peer) {
          if (cooldown.size >= 256) for (const [k, until] of cooldown) if (now() >= until) cooldown.delete(k);
          if (cooldown.size < 256) cooldown.set(peer, now() + cooldownMs);
        }
        note('blocked-pair', 1);
        session.close();
      };
      const remote = async (sdp: string): Promise<string> => {
        approved = false;
        if (!hasTailnetRangeCandidate(sdp)) return sdp;
        const current = await status();
        if (!current) return sdp;
        const coolingDown = cooling(peer);
        const out = filterTailnetCandidates(sdp, (ip) => isTailnetAddress(current, ip),
          (ip) => !coolingDown && addressIsDirect(current, ip));
        if (out.stripped) note('stripped', out.stripped);
        if (out.kept) note('kept', out.kept);
        approved = out.kept > 0;
        return out.sdp;
      };
      const own = async (sdp: string, reveal: boolean): Promise<string> => {
        if (!hasTailnetRangeCandidate(sdp)) return sdp;
        const current = await status();
        if (!current) return sdp;
        if (reveal && !cooling(peer)) return sdp;
        const out = filterTailnetCandidates(sdp, (ip) => isTailnetAddress(current, ip), () => false);
        if (out.stripped) note('stripped', out.stripped);
        return out.sdp;
      };
      const flush = () => {
        const queued = held;
        held = [];
        openPending = false;
        for (const text of queued) if (!finished) events.message(text);
      };
      session = runtime.create(id, {
        ...events,
        message: (text) => {
          if (!openPending) { events.message(text); return; }
          if (held.length >= 256) { block(); return; }
          held.push(text);
        },
        closed: (reason) => { finished = true; held = []; events.closed(blocked ? 'tailnet-unapproved' : reason); },
        open: (info) => {
          const addresses = info?.tailnetAddresses;
          if (!addresses?.length) { events.open(); return; }
          // The pair touches Tailscale's ranges; only Tailscale's own address list says whether it is a tailnet pair.
          // Frames that arrive while it decides are held and delivered in order after open.
          openPending = true;
          void status().then((current) => {
            if (finished) return;
            const viaTailnet = !!current && addresses.some((ip) => isTailnetAddress(current, ip));
            if (viaTailnet && !approved) { block(); return; }
            if (viaTailnet) events.open({ viaTailnet: true }); else events.open();
            flush();
          });
        },
      }, createOptions);
      return {
        async offer() { return own(await session.offer(), true); },
        async accept(sdp) {
          const filtered = await remote(sdp);
          return own(await session.accept(filtered), approved);
        },
        async answer(sdp) { await session.answer(await remote(sdp)); },
        send: (text) => session.send(text),
        get bufferedAmount() { return session.bufferedAmount; },
        close: () => session.close(),
      };
    },
  };
}
