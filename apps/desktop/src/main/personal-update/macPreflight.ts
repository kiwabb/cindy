import { execFile } from 'node:child_process';
import { readLocalSigningIdentity } from './signing-core.mjs';
import type { PersonalFailureCode } from './failure.js';

const INSTALLED_APP = '/Applications/Cindy.app';
const SWAP_HELPER = '/Applications/Cindy.app/Contents/Resources/tools/personal-update/swap-apps';

/** `codesign -d --verbose=2` output (it prints to stderr), or null when the command could not run. */
export type CodesignDisplay = (target: string) => Promise<string | null>;

const codesignDisplay: CodesignDisplay = target => new Promise(resolve => {
  execFile('/usr/bin/codesign', ['-d', '--verbose=2', target], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 },
    (error, stdout, stderr) => resolve(error && !stderr ? null : `${stdout ?? ''}${stderr ?? ''}`));
});

function teamIdentifier(display: string): string | null {
  const value = /(?:^|\n)TeamIdentifier=([^\r\n]+)/.exec(display)?.[1]?.trim();
  return value && value !== 'not set' ? value : null;
}

/**
 * Cheap macOS check made before a personal update is downloaded: the configured signing identity must be
 * an Apple Development team and the installed app and swap helper must already carry that team. It only
 * reports a definite mismatch; anything it cannot read returns null and is left to the preparation worker,
 * which still performs the full signature verification.
 */
export async function checkMacPreparationPrerequisites(deps: {
  readSigning?: () => { signingKind?: string; teamId?: string };
  display?: CodesignDisplay;
} = {}): Promise<PersonalFailureCode | null> {
  let signing: { signingKind?: string; teamId?: string };
  try { signing = (deps.readSigning ?? readLocalSigningIdentity)(); }
  catch { return 'PERSONAL_UPDATE_SIGNING_IDENTITY_UNAVAILABLE'; }
  if (signing.signingKind !== 'apple-development' || typeof signing.teamId !== 'string') return 'PERSONAL_UPDATE_REQUIRES_APPLE_DEVELOPMENT';
  const display = deps.display ?? codesignDisplay;
  for (const [target, code] of [[INSTALLED_APP, 'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE'], [SWAP_HELPER, 'PERSONAL_UPDATE_HELPER_SIGNATURE']] as const) {
    const output = await display(target);
    if (output === null) return null;
    if (teamIdentifier(output) !== signing.teamId) return code;
  }
  return null;
}
