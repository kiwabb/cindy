import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { personalChannelTarget, validatePersonalIdentity, validatePersonalManifest } from '../../src/main/personal-update/contract.mjs';

export function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Per-channel asset names. Mac keeps its original names; the Windows installer is a first-install asset. */
export function personalReleaseAssets(policy) {
  const target = personalChannelTarget(policy.channel);
  const zip = `cindy-unversioned-${target.arch}.zip`;
  const common = ['build-info.json', 'personal-update.json'];
  if (target.platform === 'win32') return { zip, files: [zip, 'cindy-unversioned-Setup.exe', ...common, 'SHA256SUMS'] };
  return { zip, files: [zip, 'cindy-unversioned-arm64.dmg', ...common, 'SHA256SUMS'] };
}

export function createPersonalUpdateManifest({ buildInfo, artifactDir, policy }) {
  const identity = validatePersonalIdentity(buildInfo.personalUpdate, policy);
  if (buildInfo.commitSha !== identity.sourceCommit || buildInfo.platform !== identity.platform
    || buildInfo.arch !== identity.arch || buildInfo.region !== identity.region || buildInfo.versionless !== true) {
    throw new Error('Build information does not match the personal update identity');
  }
  const zip = buildInfo.files.filter(file => file.name.endsWith('.zip'));
  if (zip.length !== 1 || zip[0].name !== personalReleaseAssets(policy).zip) {
    throw new Error(`Expected the personal ${identity.platform === 'win32' ? 'Windows' : 'Mac'} packaged ZIP`);
  }
  const file = zip[0];
  const zipPath = path.join(artifactDir, file.name);
  if (fs.statSync(zipPath).size !== file.size || hashFile(zipPath) !== file.sha256) throw new Error('Personal update ZIP integrity mismatch');
  return validatePersonalManifest({
    ...identity,
    asset: {
      url: `https://github.com/${policy.repository}/releases/download/${policy.channel}-r${identity.revision}/${file.name}`,
      sha256: file.sha256,
      size: file.size,
    },
  }, policy);
}

export function assertPackagedPersonalIdentity(sourceMetadata, identity, policy) {
  const packaged = validatePersonalIdentity(sourceMetadata.personalUpdate, policy);
  const expected = validatePersonalIdentity(identity, policy);
  if (sourceMetadata.sourceCommit !== expected.sourceCommit || !isDeepStrictEqual(packaged, expected)) {
    throw new Error('Packaged source metadata differs from the personal update release');
  }
  return packaged;
}
