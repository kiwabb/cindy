import { runSmokeTest } from './lib.mjs';
export { readLocalSigningIdentity, verifyLocalSigningTrust, localDesignatedRequirement, appleDevelopmentRequirement, localCodesignArguments, verifyAppleDevelopmentSignature, readLocalSigningIdentifier, signLocalMacApp } from '../../src/main/personal-update/signing-core.mjs';

export function smokeLocalSignedApp({ arch, region, skipSmoke, hostCanRunArm64 }, smoke = runSmokeTest) {
  if (skipSmoke || (arch === 'arm64' && !hostCanRunArm64)) return;
  smoke('darwin', arch, region);
}
