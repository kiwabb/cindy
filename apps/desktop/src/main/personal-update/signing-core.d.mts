export interface LocalIdentity { certificateSha1: string; keychainPath: string; signingKind?: 'self-signed' | 'apple-development'; teamId?: string }
export function readLocalSigningIdentity(metadataPath?: string): LocalIdentity;
export function signLocalMacApp(appPath: string, helperEntitlements: string, mainEntitlements: string, identity?: LocalIdentity): unknown;
export function writeMacEntitlements(path: string, options?: { appleEvents?: boolean; keychainAccessGroup?: string }): void;
export function appleDevelopmentRequirement(identifier: string, teamId: string): string;
export function readLocalSigningIdentifier(targetPath: string, appPath: string): string;
export function verifyAppleDevelopmentSignature(targetPath: string, identifier: string, teamId: string): void;

export function withLocalSigningCommandRunner<T>(runner: (command: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => import('node:child_process').SpawnSyncReturns<string>, operation: () => T): T;
