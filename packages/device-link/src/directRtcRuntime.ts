/// <reference lib="dom" />
import { MAX_FRAME_BYTES } from './protocol.js';
import { hasTailnetRangeCandidate, isTailnetRangeAddress } from './tailnetPath.js';
import type { DirectRuntime, DirectRuntimeEvents, DirectRuntimeSession, DirectRuntimeCloseReason } from './directNegotiation.js';

/** Selected-pair addresses inside Tailscale's ranges (local and remote, at most 2); [] when none or unknown. */
async function tailnetPairAddresses(pc: RTCPeerConnection): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => pc.getStats()).then((report) => {
        const entries = new Map<string, Record<string, unknown>>();
        report.forEach((entry: Record<string, unknown>, id: string) => entries.set(id, entry));
        let pairId: unknown;
        for (const entry of entries.values()) if (entry.type === 'transport' && entry.selectedCandidatePairId) pairId = entry.selectedCandidatePairId;
        const pair = (pairId ? entries.get(pairId as string) : undefined)
          ?? [...entries.values()].find((e) => e.type === 'candidate-pair' && e.nominated === true && e.state === 'succeeded');
        if (!pair) return [];
        const out: string[] = [];
        for (const id of [pair.localCandidateId, pair.remoteCandidateId]) {
          const c = typeof id === 'string' ? entries.get(id) : undefined;
          const address = c?.address ?? c?.ip;
          if (typeof address === 'string' && isTailnetRangeAddress(address)) out.push(address);
        }
        return out;
      }).catch(() => [] as string[]),
      new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), 500); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Data-only WebRTC, shared by Electron and the isolated Mobile WebView. No STUN/TURN:
 * host candidates try the LAN, and the existing authenticated relay is the fallback.
 * Binary fragments preserve UTF-8 (including surrogate pairs) across 16 KiB SCTP limits. */
export function createDirectRtcRuntime(): DirectRuntime {
  return { create(_id: string, events: DirectRuntimeEvents): DirectRuntimeSession {
    const pc = new RTCPeerConnection({ iceServers: [] });
    let dc: RTCDataChannel | undefined;
    let closed = false;
    let receiveBytes = 0;
    // Frames that arrive before the (possibly deferred) open event are held and delivered in order after it.
    let opened = false;
    let early: string[] = [];
    let earlyBytes = 0;
    let sawTailnetRange = false;
    let parts: Uint8Array[] = [];
    let receiveTimer: ReturnType<typeof setTimeout> | undefined;
    let bufferTimer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const close = (reason: DirectRuntimeCloseReason = 'channel-closed') => {
      if (closed) return;
      closed = true;
      clearTimeout(receiveTimer);
      clearTimeout(bufferTimer);
      parts = [];
      early = [];
      dc?.close();
      pc.close();
      events.closed(reason);
    };
    const scheduleBufferReport = () => {
      if (!closed && dc && dc.bufferedAmount > 0 && !bufferTimer) {
        bufferTimer = setTimeout(() => {
          bufferTimer = undefined;
          reportBuffer();
        }, 100);
      }
    };
    const reportBuffer = () => {
      if (closed) return;
      events.drained();
      scheduleBufferReport();
    };
    const bind = (channel: RTCDataChannel) => {
      if (closed || dc || channel.label !== 'device-link-v1' || !channel.ordered
        || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) { channel.close(); return; }
      dc = channel;
      dc.binaryType = 'arraybuffer';
      // Always report the final zero, including messages smaller than a low-water mark.
      dc.bufferedAmountLowThreshold = 0;
      dc.onopen = () => {
        if (closed) return;
        const report = (info?: { tailnetAddresses: string[] }) => {
          if (closed) return;
          if (info) events.open(info); else events.open();
          opened = true;
          const queued = early;
          early = [];
          earlyBytes = 0;
          for (const text of queued) if (!closed) events.message(text);
        };
        // Only when an SDP carried an address in Tailscale's ranges is the selected pair inspected (bounded
        // by 500 ms); every other channel opens synchronously, exactly as before.
        if (!sawTailnetRange || typeof pc.getStats !== 'function') { report(); return; }
        void tailnetPairAddresses(pc).then((addresses) => report(addresses.length ? { tailnetAddresses: addresses } : undefined));
      };
      dc.onclose = () => close();
      dc.onerror = () => close('network-failed');
      dc.onbufferedamountlow = () => {
        clearTimeout(bufferTimer);
        bufferTimer = undefined;
        reportBuffer();
      };
      dc.onmessage = ({ data }) => {
        try {
          if (closed || !(data instanceof ArrayBuffer) || data.byteLength < 2 || data.byteLength > 16 * 1024) throw new Error();
          const frame = new Uint8Array(data);
          if (frame[0] !== 0 && frame[0] !== 1) throw new Error();
          receiveBytes += frame.length - 1;
          if (receiveBytes > MAX_FRAME_BYTES || parts.length >= 256) throw new Error();
          parts.push(frame.subarray(1));
          clearTimeout(receiveTimer);
          if (frame[0] === 0) { receiveTimer = setTimeout(close, 10_000); return; }
          const bytes = new Uint8Array(receiveBytes);
          let offset = 0;
          for (const part of parts) { bytes.set(part, offset); offset += part.length; }
          parts = [];
          receiveBytes = 0;
          const text = decoder.decode(bytes);
          if (opened) events.message(text);
          else {
            earlyBytes += bytes.length;
            if (earlyBytes > 3 * MAX_FRAME_BYTES) throw new Error();
            early.push(text);
          }
        } catch { close(); }
      };
    };
    pc.ondatachannel = ({ channel }) => bind(channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        close('network-failed');
      } else if (pc.connectionState === 'closed') close();
    };
    const gather = async (description: RTCSessionDescriptionInit): Promise<string> => {
      await pc.setLocalDescription(description);
      if (pc.iceGatheringState !== 'complete' && !closed) await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 3_000);
        function done() { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); }
        function changed() { if (pc.iceGatheringState === 'complete' || closed) done(); }
        pc.addEventListener('icegatheringstatechange', changed);
        changed();
      });
      if (closed || !pc.localDescription?.sdp) throw new Error('DIRECT_CHANNEL_CLOSED');
      if (hasTailnetRangeCandidate(pc.localDescription.sdp)) sawTailnetRange = true;
      return pc.localDescription.sdp;
    };
    return {
      async offer() {
        bind(pc.createDataChannel('device-link-v1', { ordered: true }));
        return gather(await pc.createOffer());
      },
      async accept(sdp) {
        if (hasTailnetRangeCandidate(sdp)) sawTailnetRange = true;
        await pc.setRemoteDescription({ type: 'offer', sdp });
        return gather(await pc.createAnswer());
      },
      async answer(sdp) {
        if (hasTailnetRangeCandidate(sdp)) sawTailnetRange = true;
        await pc.setRemoteDescription({ type: 'answer', sdp });
      },
      send(text) {
        if (closed || dc?.readyState !== 'open') throw new Error('DIRECT_CHANNEL_CLOSED');
        const bytes = encoder.encode(text);
        if (!bytes.length || bytes.length > MAX_FRAME_BYTES || dc.bufferedAmount > 3 * MAX_FRAME_BYTES) throw new Error('DIRECT_CHANNEL_BACKPRESSURE');
        try {
          for (let offset = 0; offset < bytes.length; offset += 16 * 1024 - 1) {
            const end = Math.min(bytes.length, offset + 16 * 1024 - 1);
            const frame = new Uint8Array(end - offset + 1);
            frame[0] = end === bytes.length ? 1 : 0;
            frame.set(bytes.subarray(offset, end), 1);
            dc.send(frame.buffer);
          }
          // Report ongoing drain while busy, then stop at zero. Never notify synchronously
          // from send(): native bridges and the reliable sender must commit their sequence first.
          scheduleBufferReport();
        } catch (error) { close(); throw error; }
      },
      get bufferedAmount() { return dc?.bufferedAmount ?? 0; },
      close: () => close(),
    };
  } };
}
