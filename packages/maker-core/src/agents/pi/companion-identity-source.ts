// Loaded explicitly by the host for owner-private lanes only. It runs after Pi
// assembles its native sections, so replacing the preamble keeps tools, rules,
// docs and all Cindy addenda. Never pass --system-prompt for this purpose.
export const CINDY_PI_COMPANION_IDENTITY_EXTENSION = 'cindy-companion-identity.ts';
export const CINDY_PI_COMPANION_IDENTITY_MODE = 'cindy-companion-identity-mode';

export const CINDY_PI_COMPANION_IDENTITY_SOURCE = String.raw`
import { readFileSync } from 'node:fs';

const nativePreambles = [
  // Pi 1.4
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.',
  // Pi 1.5
  'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.',
];

const companionPreamble = [
  'You are the companion described in the active Cindy profile and SOUL below.',
  'Speak to the owner from that identity and relationship, including when they ask you to research or do work.',
  'Use the available tools and follow their rules, permissions and privacy limits. Be honest about your nature, capabilities and what actually happened.',
].join(' ');

export default function companionIdentity(pi: any) {
  pi.on('before_agent_start', (event: { systemPrompt?: string }) => {
    let mode: string;
    try {
      mode = readFileSync(new URL('./cindy-companion-identity-mode', import.meta.url), 'utf8');
    } catch {
      return;
    }
    if (mode !== 'companion' || typeof event.systemPrompt !== 'string') return;
    const prompt = event.systemPrompt;
    // Only replace a verified native preamble at its section boundary. A
    // deliberate SYSTEM.md or a new upstream template must survive intact.
    const prefix = nativePreambles.find(text => prompt === text || prompt.startsWith(text + '\n\n'));
    if (prefix) return { systemPrompt: companionPreamble + prompt.slice(prefix.length) };
  });
}
`;
