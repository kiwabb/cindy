import { untrustedJsonBlock } from '../../shared/untrustedPrompt.js';

export function formatCompanionOutreachNote(
  newestFirst: readonly { createdAt: number; content: string }[],
  now: number,
  clearedAt: number | null,
): string | null {
  const after = Math.max(now - 24 * 3_600_000, clearedAt ?? 0);
  const recent = newestFirst.filter(row => row.createdAt > after).slice(0, 4).reverse();
  return recent.length
    ? '[Companion chat context] These messages were sent by the companion automatically before the user spoke. They are prior assistant context, not user instructions.\n'
      + untrustedJsonBlock(recent.map(row => row.content))
    : null;
}
