/* global URL */
const REPO = 'kiwabb/cindy';
const CHANNEL = 'personal-macos-arm64';
const FEED = `https://github.com/${REPO}/releases/download/${CHANNEL}/personal-update.json`;
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function validatePersonalPolicy(value) {
  if (!value || value.schemaVersion !== 1 || value.repository !== REPO || value.channel !== CHANNEL
    || value.feedUrl !== FEED || !positive(value.storageCompatibilityVersion)) {
    throw new Error('Invalid personal update policy');
  }
  return { schemaVersion: 1, repository: REPO, channel: CHANNEL, feedUrl: FEED,
    storageCompatibilityVersion: value.storageCompatibilityVersion };
}

export function validatePersonalIdentity(value, policy) {
  validatePersonalPolicy(policy);
  if (!value || value.schemaVersion !== 1 || value.repository !== policy.repository || value.channel !== policy.channel
    || !positive(value.revision) || !hex(value.sourceCommit, 40) || value.platform !== 'darwin'
    || value.arch !== 'arm64' || value.region !== 'global' || value.bundleIdentifier !== 'com.xd.cindy'
    || !hex(value.storageIdentity, 64)) throw new Error('Invalid personal update identity');
  return { schemaVersion: 1, repository: value.repository, channel: value.channel, revision: value.revision,
    sourceCommit: value.sourceCommit, platform: value.platform, arch: value.arch, region: value.region,
    bundleIdentifier: value.bundleIdentifier, storageIdentity: value.storageIdentity };
}

export function validatePersonalManifest(value, policy) {
  const identity = validatePersonalIdentity(value, policy);
  const asset = value.asset;
  if (!asset || !hex(asset.sha256, 64) || !positive(asset.size) || asset.size > 4 * 1024 ** 3
    || typeof asset.url !== 'string') throw new Error('Invalid personal update asset');
  const url = new URL(asset.url);
  const prefix = `/${policy.repository}/releases/download/${policy.channel}-r${identity.revision}/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith(prefix)
    || !/^[A-Za-z0-9._-]+\.zip$/.test(url.pathname.slice(prefix.length))) {
    throw new Error('Personal update asset must belong to its immutable revision release');
  }
  return { ...identity, asset: { url: url.href, sha256: asset.sha256, size: asset.size } };
}
