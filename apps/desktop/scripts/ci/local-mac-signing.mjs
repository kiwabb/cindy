import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectMacSigningTargets, runSmokeTest, verifyMacContactsPermissions } from './lib.mjs';

export function smokeLocalSignedApp({ arch, region, skipSmoke, hostCanRunArm64 }, smoke = runSmokeTest) {
  if (skipSmoke || (arch === 'arm64' && !hostCanRunArm64)) return;
  smoke('darwin', arch, region);
}

export function readLocalSigningIdentity(metadataPath = path.join(
  os.homedir(), 'Library', 'Application Support', 'CindyLocalSigning', 'identity.json',
)) {
  const value = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (value.schemaVersion !== 1 || !/^[a-f\d]{40}$/i.test(value.certificateSha1 ?? '')
    || typeof value.keychainPath !== 'string' || !path.isAbsolute(value.keychainPath)) {
    throw new Error('Invalid local signing identity metadata');
  }
  if (!fs.statSync(value.keychainPath).isFile()) throw new Error('Local signing keychain is missing');
  return { certificateSha1: value.certificateSha1.toUpperCase(), keychainPath: value.keychainPath };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** Check only the configured public leaf certificate's code-signing trust. */
export function verifyLocalSigningTrust(identity) {
  const output = run('/usr/bin/security', ['find-certificate', '-a', '-p', identity.keychainPath]);
  const certificates = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const selected = certificates.filter(pem => new X509Certificate(pem).fingerprint.replaceAll(':', '').toUpperCase()
    === identity.certificateSha1.toUpperCase());
  if (selected.length !== 1) throw new Error('The configured local public signing certificate is missing or ambiguous');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-local-signing-trust-'));
  try {
    const certificatePath = path.join(directory, 'leaf.pem');
    fs.writeFileSync(certificatePath, selected[0], { mode: 0o600 });
    try {
      run('/usr/bin/security', ['verify-cert', '-L', '-p', 'codeSign', '-c', certificatePath, '-k', identity.keychainPath]);
    } catch (error) {
      throw new Error(`Local signing certificate ${identity.certificateSha1} is not trusted for code signing. Ask the owner to confirm code-signing trust for this dedicated certificate in Keychain Access before building. Trust was not changed.`, { cause: error });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function localDesignatedRequirement(identifier, certificateSha1) {
  if (!/^[A-Za-z\d._-]+$/.test(identifier) || !/^[a-f\d]{40}$/i.test(certificateSha1)) {
    throw new Error('Invalid local signing requirement identity');
  }
  return `identifier "${identifier}" and certificate leaf = H"${certificateSha1.toUpperCase()}"`;
}

export function localCodesignArguments(identifier, identity) {
  const requirement = localDesignatedRequirement(identifier, identity.certificateSha1);
  return {
    sign: ['--force', '--timestamp=none', '--options', 'runtime', '--sign', identity.certificateSha1,
      '--keychain', identity.keychainPath, '--identifier', identifier, '--requirements', `=designated => ${requirement}`],
    verify: ['--verify', '--strict', '-R', `=${requirement}`],
  };
}

export function readLocalSigningIdentifier(targetPath, appPath) {
  if (targetPath.endsWith('.app') || targetPath.endsWith('.framework')) {
    const plistPath = targetPath.endsWith('.app')
      ? path.join(targetPath, 'Contents', 'Info.plist')
      : path.join(targetPath, 'Resources', 'Info.plist');
    // Forge may have changed the bundle ID since Electron's original signature.
    const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath]).trim();
    if (!/^[A-Za-z\d._-]+$/.test(identifier)) throw new Error(`Invalid bundle identifier: ${targetPath}`);
    return identifier;
  }
  const display = spawnSync('/usr/bin/codesign', ['-d', '--verbose=2', targetPath], { encoding: 'utf8' });
  const existingIdentifier = /(?:^|\n)Identifier=([^\r\n]+)/.exec(display.stderr ?? '')?.[1];
  if (existingIdentifier && /^[A-Za-z\d._-]+$/.test(existingIdentifier)) return existingIdentifier;
  const relativePath = path.relative(appPath, targetPath);
  return `com.xd.cindy.local.${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`;
}

/** Sign a staged personal app copy, including nested code, retaining its bundle metadata. */
export function signLocalMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath, identity = readLocalSigningIdentity()) {
  if (process.platform !== 'darwin') throw new Error('Local signing requires macOS');
  verifyLocalSigningTrust(identity);
  // Resolve the exact public certificate fingerprint in the specified keychain.
  // The private key remains under macOS Keychain access control.
  const identities = run('/usr/bin/security', ['find-identity', '-p', 'codesigning', identity.keychainPath]);
  if (!identities.toUpperCase().includes(identity.certificateSha1.toUpperCase())) {
    throw new Error('The configured local code-signing identity is unavailable');
  }
  const targets = collectMacSigningTargets(appPath);
  for (const target of targets) {
    const identifier = readLocalSigningIdentifier(target.path, appPath);
    const { sign: args, verify } = localCodesignArguments(identifier, identity);
    const entitlements = target.main ? mainEntitlementsPath : target.helper ? helperEntitlementsPath : null;
    if (entitlements) args.push('--entitlements', entitlements);
    run('/usr/bin/codesign', [...args, target.path]);
    run('/usr/bin/codesign', [...verify, target.path]);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  verifyMacContactsPermissions(appPath);
  return { mode: 'local-only', certificateSha1: identity.certificateSha1 };
}
