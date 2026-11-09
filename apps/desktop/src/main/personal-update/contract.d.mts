export interface PersonalPolicy { schemaVersion: 1; repository: string; channel: string; feedUrl: string; storageCompatibilityVersion: number }
export interface PersonalIdentity { schemaVersion: 1; repository: string; channel: string; revision: number; sourceCommit: string; platform: 'darwin'; arch: 'arm64'; region: 'global'; bundleIdentifier: 'com.xd.cindy'; storageIdentity: string }
export interface PersonalManifest extends PersonalIdentity { asset: { url: string; sha256: string; size: number } }
export function validatePersonalPolicy(value: unknown): PersonalPolicy;
export function validatePersonalIdentity(value: unknown, policy: PersonalPolicy): PersonalIdentity;
export function validatePersonalManifest(value: unknown, policy: PersonalPolicy): PersonalManifest;
