const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Human-readable version of a personal build: `YYYY-MM-DD HH:mm · <sha7>`, with the build time in the
 * local timezone (24h). Without a usable build time only the short commit remains. This is a display
 * label; the internal `personal-r<revision>` key stays the only value compared or persisted.
 */
export function formatPersonalBuildVersion(sourceCommit: string, builtAt?: string | null): string {
  const sha = sourceCommit.slice(0, 7);
  const time = builtAt ? new Date(builtAt) : null;
  if (!time || Number.isNaN(time.getTime())) return sha;
  const date = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  return `${date} ${pad(time.getHours())}:${pad(time.getMinutes())} · ${sha}`;
}
