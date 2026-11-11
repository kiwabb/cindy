export interface PersonalPolicy { schemaVersion: 1; repository: string; channel: string; feedUrl: string; storageCompatibilityVersion: number }
export interface PersonalIdentity { schemaVersion: 1; repository: string; channel: string; revision: number; sourceCommit: string; platform: 'darwin' | 'win32'; arch: 'arm64' | 'x64'; region: 'global'; bundleIdentifier: 'com.xd.cindy'; storageIdentity: string }
export interface PersonalManifest extends PersonalIdentity { builtAt?: string; asset: { url: string; sha256: string; size: number } }
export interface PersonalChannelTarget { platform: 'darwin' | 'win32'; arch: 'arm64' | 'x64'; bundleIdentifier: 'com.xd.cindy' }
export function personalChannelTarget(channel: string): PersonalChannelTarget;
export function validatePersonalPolicy(value: unknown): PersonalPolicy;
export function resolvePersonalPolicy(file: unknown, platform: string, arch: string): PersonalPolicy | null;
export function validatePersonalIdentity(value: unknown, policy: PersonalPolicy): PersonalIdentity;
export function validatePersonalManifest(value: unknown, policy: PersonalPolicy): PersonalManifest;
export function isIsoDateString(value: unknown): value is string;
