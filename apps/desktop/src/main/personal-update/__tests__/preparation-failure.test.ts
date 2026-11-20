import { describe, expect, it } from 'vitest';
import { personalFailureCode, personalStage } from '../failure';
import { checkMacPreparationPrerequisites } from '../macPreflight';

// Regression: every preparation failure reached the main process as one generic code, so a Mac whose
// installed app was ad-hoc signed looked the same as a broken download. Each stage now reports its own
// fixed code, and underlying messages (which carry paths and certificate fingerprints) never pass through.
describe('personal preparation failure codes', () => {
  it.each([
    ['a library message naming a path', new Error('Apple development TeamIdentifier mismatch: /Applications/Cindy.app'), 'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE'],
    ['a fixed code thrown inside the stage', new Error('PERSONAL_UPDATE_SIGNING_TIMEOUT'), 'PERSONAL_UPDATE_SIGNING_TIMEOUT'],
    ['a non-Error value', 'boom', 'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE'],
  ] as const)('maps %s to a fixed code', (_label, thrown, code) => {
    expect(() => personalStage('PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE', () => { throw thrown; })).toThrow(new RegExp(`^${code}$`));
  });

  it('accepts only known codes across the worker boundary', () => {
    expect(personalFailureCode('PERSONAL_UPDATE_HELPER_SIGNATURE')).toBe('PERSONAL_UPDATE_HELPER_SIGNATURE');
    expect(personalFailureCode('Local signing certificate 0123ABCD is not trusted')).toBe('PERSONAL_UPDATE_PREPARATION_FAILED');
    expect(personalFailureCode(undefined)).toBe('PERSONAL_UPDATE_PREPARATION_FAILED');
  });
});

// The check runs before a 240 MB download, so it must catch the real-world case (an ad-hoc signed app
// installed from the CI DMG) and must not block on anything it cannot read.
describe('macOS preparation prerequisites before download', () => {
  const apple = () => ({ signingKind: 'apple-development', teamId: 'ABCDE12345' });
  const signedBy = (team: string | null) => async () => `Identifier=com.xd.cindy\n${team ? `TeamIdentifier=${team}` : 'TeamIdentifier=not set'}\n`;

  it.each([
    ['no signing identity metadata', { readSigning: () => { throw new Error('ENOENT /Users/someone/Library'); } }, 'PERSONAL_UPDATE_SIGNING_IDENTITY_UNAVAILABLE'],
    ['a self-signed identity', { readSigning: () => ({}) }, 'PERSONAL_UPDATE_REQUIRES_APPLE_DEVELOPMENT'],
    ['an ad-hoc signed installed app', { readSigning: apple, display: signedBy(null) }, 'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE'],
    ['an app from another team', { readSigning: apple, display: signedBy('ZZZZZ99999') }, 'PERSONAL_UPDATE_INSTALLED_APP_SIGNATURE'],
    ['an ad-hoc helper inside a team-signed app', {
      readSigning: apple,
      display: async (target: string) => (target.endsWith('swap-apps') ? signedBy(null) : signedBy('ABCDE12345'))(),
    }, 'PERSONAL_UPDATE_HELPER_SIGNATURE'],
    ['an install signed by the configured team', { readSigning: apple, display: signedBy('ABCDE12345') }, null],
    ['codesign that cannot run', { readSigning: apple, display: async () => null }, null],
  ] as const)('reports %s', async (_label, deps, expected) => {
    await expect(checkMacPreparationPrerequisites(deps)).resolves.toBe(expected);
  });
});
