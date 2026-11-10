/* global URL */
const REPO = 'kiwabb/cindy';
/** Each personal channel serves exactly one packaged target. */
const TARGETS = Object.freeze({
  'personal-macos-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64', bundleIdentifier: 'com.xd.cindy' }),
  'personal-windows-x64': Object.freeze({ platform: 'win32', arch: 'x64', bundleIdentifier: 'com.xd.cindy' }),
});
const feedFor = channel => `https://github.com/${REPO}/releases/download/${channel}/personal-update.json`;
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function personalChannelTarget(channel) {
  const target = Object.hasOwn(TARGETS, channel) ? TARGETS[channel] : undefined;
  if (!target) throw new Error('Unknown personal update channel');
  return target;
}

/** Validate one resolved channel policy (the shape every producer and client step uses). */
export function validatePersonalPolicy(value) {
  if (!value || value.schemaVersion !== 1 || value.repository !== REPO || !Object.hasOwn(TARGETS, value.channel)
    || value.feedUrl !== feedFor(value.channel) || !positive(value.storageCompatibilityVersion)) {
    throw new Error('Invalid personal update policy');
  }
  return { schemaVersion: 1, repository: REPO, channel: value.channel, feedUrl: feedFor(value.channel),
    storageCompatibilityVersion: value.storageCompatibilityVersion };
}

/**
 * Resolve personal-update-channel.json to the channel for one packaged target.
 * Returns null when that target has no personal channel.
 */
export function resolvePersonalPolicy(file, platform, arch) {
  const channels = file?.channels;
  if (!file || file.schemaVersion !== 2 || file.repository !== REPO || !positive(file.storageCompatibilityVersion)
    || !channels || typeof channels !== 'object' || Array.isArray(channels)
    || Object.entries(channels).some(([key, channel]) => !Object.hasOwn(TARGETS, channel)
      || key !== `${TARGETS[channel].platform}-${TARGETS[channel].arch}`)) {
    throw new Error('Invalid personal update channel file');
  }
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(channels, key)) return null;
  return validatePersonalPolicy({ schemaVersion: 1, repository: REPO, channel: channels[key],
    feedUrl: feedFor(channels[key]), storageCompatibilityVersion: file.storageCompatibilityVersion });
}

export function validatePersonalIdentity(value, policy) {
  validatePersonalPolicy(policy);
  const target = personalChannelTarget(policy.channel);
  if (!value || value.schemaVersion !== 1 || value.repository !== policy.repository || value.channel !== policy.channel
    || !positive(value.revision) || !hex(value.sourceCommit, 40) || value.platform !== target.platform
    || value.arch !== target.arch || value.region !== 'global' || value.bundleIdentifier !== target.bundleIdentifier
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
