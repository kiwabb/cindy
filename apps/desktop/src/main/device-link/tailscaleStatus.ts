import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseTailscaleStatus, type TailnetStatus } from '@cindy/device-link';

/**
 * Read-only Tailscale status for the direct-link candidate policy. Runs `status --json` only (never
 * up/serve/funnel/set), only when a negotiation holds an address in Tailscale's ranges, no background polling.
 * At most one process per refresh; success and failure are both cached for 30 s and concurrent callers share
 * it. Output is capped at 4 MB (more means unreadable, no policy) and never reaches logs.
 */
export const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
export const TAILSCALE_STATUS_TTL_MS = 30_000;
export const TAILSCALE_STATUS_MAX_BYTES = 4 * 1024 * 1024;

/** Absolute install locations only on Windows (never a bare name, which could resolve from the cwd); PATH on POSIX. */
export function tailscaleCliCandidates(platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    return [env.ProgramFiles, env.ProgramW6432]
      .filter((base): base is string => !!base && path.isAbsolute(base))
      .map((base) => path.join(base, 'Tailscale', 'tailscale.exe'))
      .filter((file, index, all) => all.indexOf(file) === index);
  }
  if (platform === 'darwin') {
    return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale', 'tailscale'];
  }
  return ['tailscale'];
}

export interface TailscaleStatusDeps {
  exec(file: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean },
    callback: (error: Error | null, stdout: string) => void): void;
  candidates(): string[];
  exists(file: string): boolean;
  now(): number;
}
const realDeps: TailscaleStatusDeps = {
  exec: (file, args, options, callback) => { execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => callback(error, stdout)); },
  candidates: () => tailscaleCliCandidates(),
  exists: (file) => existsSync(file),
  now: () => Date.now(),
};

export function createTailscaleStatusReader(deps: TailscaleStatusDeps = realDeps): () => Promise<TailnetStatus | null> {
  let cached: { at: number; value: TailnetStatus | null } | undefined;
  let inflight: Promise<TailnetStatus | null> | undefined;
  const run = (file: string) => new Promise<TailnetStatus | null>((resolve) => {
    try {
      deps.exec(file, ['status', '--json'],
        { timeout: TAILSCALE_STATUS_TIMEOUT_MS, maxBuffer: TAILSCALE_STATUS_MAX_BYTES, windowsHide: true },
        (error, stdout) => {
          if (error || stdout.length > TAILSCALE_STATUS_MAX_BYTES) { resolve(null); return; }
          try { resolve(parseTailscaleStatus(JSON.parse(stdout))); } catch { resolve(null); }
        });
    } catch { resolve(null); }
  });
  return () => {
    if (cached && deps.now() - cached.at < TAILSCALE_STATUS_TTL_MS) return Promise.resolve(cached.value);
    return inflight ??= (async () => {
      try {
        // An absolute path must exist; a bare name is resolved through PATH by execFile (POSIX only).
        const file = deps.candidates().find((c) => (path.isAbsolute(c) ? deps.exists(c) : true));
        const value = file ? await run(file) : null;
        cached = { at: deps.now(), value };
        return value;
      } finally { inflight = undefined; }
    })();
  };
}

export const readTailscaleStatus = createTailscaleStatusReader();
