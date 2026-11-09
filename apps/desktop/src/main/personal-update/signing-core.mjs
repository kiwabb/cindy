/* global console */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';

let commandRunner = null;
export function withLocalSigningCommandRunner(runner, operation) {
  const previous = commandRunner;
  commandRunner = runner;
  try { return operation(); } finally { commandRunner = previous; }
}
function nativeCommand(command, args, options) {
  return commandRunner ? commandRunner(command, args, options) : spawnSync(command, args, { timeout: 120_000, killSignal: 'SIGKILL', ...options });
}

function escapeXmlText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function writeMacEntitlements(destPath, { appleEvents = false, keychainAccessGroup } = {}) {
  const appleEventsEntitlement = appleEvents
    ? `    <key>com.apple.security.automation.apple-events</key>
    <true/>
`
    : '';
  const keychainAccessGroupEntitlement = keychainAccessGroup
    ? `    <key>keychain-access-groups</key>
    <array>
        <string>${escapeXmlText(keychainAccessGroup)}</string>
    </array>
`
    : '';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
${appleEventsEntitlement}${keychainAccessGroupEntitlement}</dict>
</plist>`;
  fs.writeFileSync(destPath, content);
}

function readCodesignEntitlements(bundlePath) {
  const result = nativeCommand(
    '/usr/bin/codesign',
    ['-d', '--entitlements', '-', '--xml', bundlePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`codesign entitlement inspection failed for ${bundlePath}: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function parseCodesignTeamIdentifier(output) {
  return (
    String(output ?? '')
      .match(/^TeamIdentifier=(.+)$/m)?.[1]
      ?.trim() ?? ''
  );
}

function readCodesignTeamIdentifier(bundlePath) {
  const result = nativeCommand('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `codesign identity inspection failed for ${bundlePath}: ${result.stderr || result.stdout}`,
    );
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return parseCodesignTeamIdentifier(output);
}

function hasAppleEventsEntitlement(entitlements) {
  return /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/.test(
    entitlements,
  );
}

function hasKeychainAccessGroup(entitlements, keychainAccessGroup) {
  const escaped = keychainAccessGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `<key>keychain-access-groups<\\/key>\\s*<array>[\\s\\S]*?<string>${escaped}<\\/string>[\\s\\S]*?<\\/array>`,
  ).test(entitlements);
}

function readPlistString(infoPlistPath, key) {
  const result = nativeCommand(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, infoPlistPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`packaged Info.plist is missing ${key}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function readMacBundleIdentifier(appPath) {
  return readPlistString(path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleIdentifier');
}

/** Verify the packaged Contacts/JXA privacy contract after signing. */
export function verifyMacContactsPermissions(appPath, { keychainAccessGroup, signingTeamId } = {}) {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const appleEventsUsage = readPlistString(infoPlistPath, 'NSAppleEventsUsageDescription');
  const contactsUsage = readPlistString(infoPlistPath, 'NSContactsUsageDescription');
  for (const [key, value] of [
    ['NSAppleEventsUsageDescription', appleEventsUsage],
    ['NSContactsUsageDescription', contactsUsage],
  ]) {
    if (!/import/i.test(value) || !/(add|update|export)/i.test(value)) {
      throw new Error(`${key} must accurately describe Contacts import and explicit export/update`);
    }
  }

  const mainEntitlements = readCodesignEntitlements(appPath);
  if (!hasAppleEventsEntitlement(mainEntitlements)) {
    throw new Error('main app is missing com.apple.security.automation.apple-events=true');
  }
  if (keychainAccessGroup && !hasKeychainAccessGroup(mainEntitlements, keychainAccessGroup)) {
    throw new Error(`main app is missing WebAuthn keychain access group ${keychainAccessGroup}`);
  }
  if (signingTeamId) {
    const actualTeamId = readCodesignTeamIdentifier(appPath);
    if (actualTeamId !== signingTeamId) {
      throw new Error(
        `macOS signature TeamIdentifier mismatch: expected ${signingTeamId}, got ${actualTeamId || '(empty)'}`,
      );
    }
  }
  if (
    keychainAccessGroup &&
    !fs.existsSync(path.join(appPath, 'Contents', 'embedded.provisionprofile'))
  ) {
    throw new Error('main app is missing the WebAuthn provisioning profile');
  }

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const helperApps = fs.readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(frameworksDir, entry.name));
  for (const helperApp of helperApps) {
    if (hasAppleEventsEntitlement(readCodesignEntitlements(helperApp))) {
      throw new Error(`helper app must not receive Apple Events entitlement: ${helperApp}`);
    }
    if (
      keychainAccessGroup &&
      hasKeychainAccessGroup(readCodesignEntitlements(helperApp), keychainAccessGroup)
    ) {
      throw new Error(`helper app must not receive WebAuthn keychain access group: ${helperApp}`);
    }
  }
  console.log(
    `==> Verified macOS Contacts usage descriptions and main-only Apple Events${keychainAccessGroup ? ' / WebAuthn' : ''} entitlements`,
  );
}

/** Collect nested signing targets inside-out for a staged personal app. */
export function collectMacSigningTargets(appPath) {
  const targets = [];
  const scan = (directory, helperApps) => {
    if (!fs.existsSync(directory)) return;
    const bundles = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const filePath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(filePath);
          if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) {
            bundles.push({ path: filePath, helper: helperApps && entry.name.endsWith('.app') });
          }
        } else if (entry.isFile()) {
          const result = nativeCommand('/usr/bin/file', ['-b', filePath], { encoding: 'utf8' });
          if (result.status !== 0) throw new Error(`Cannot inspect signing target: ${filePath}`);
          if (result.stdout.includes('Mach-O')) targets.push({ path: filePath, helper: false });
        }
      }
    };
    walk(directory);
    targets.push(...bundles);
  };
  scan(path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked'), false);
  scan(path.join(appPath, 'Contents', 'Resources', 'tools'), false);
  scan(path.join(appPath, 'Contents', 'Frameworks'), true);
  targets.push({ path: appPath, main: true });
  return targets;
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
  const identity = { certificateSha1: value.certificateSha1.toUpperCase(), keychainPath: value.keychainPath };
  if (value.signingKind === undefined || value.signingKind === 'self-signed') return identity;
  if (value.signingKind !== 'apple-development' || typeof value.teamId !== 'string'
    || !/^[A-Z\d]{10}$/.test(value.teamId)) {
    throw new Error('Invalid local signing kind or Apple development team');
  }
  return { ...identity, signingKind: value.signingKind, teamId: value.teamId };
}

function run(command, args) {
  const result = nativeCommand(command, args, { encoding: 'utf8' });
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
      if (identity.signingKind === 'apple-development') {
        throw new Error('Apple development certificate code-signing trust failed. Check the valid Apple-issued certificate and its WWDR intermediate chain in Keychain Access.', { cause: error });
      }
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

export function appleDevelopmentRequirement(identifier, teamId) {
  if (!/^[A-Za-z\d._-]+$/.test(identifier) || typeof teamId !== 'string' || !/^[A-Z\d]{10}$/.test(teamId)) {
    throw new Error('Invalid Apple development requirement identity');
  }
  return `identifier "${identifier}" and anchor apple generic`
    + ' and certificate 1[field.1.2.840.113635.100.6.2.1] exists'
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.12] exists'
    + ` and certificate leaf[subject.OU] = "${teamId}"`;
}

export function localCodesignArguments(identifier, identity) {
  if (!/^[a-f\d]{40}$/i.test(identity.certificateSha1 ?? '')) {
    throw new Error('Invalid local signing certificate fingerprint');
  }
  if (identity.signingKind !== undefined && !['self-signed', 'apple-development'].includes(identity.signingKind)) {
    throw new Error('Unknown local signing kind');
  }
  const requirement = identity.signingKind === 'apple-development'
    ? appleDevelopmentRequirement(identifier, identity.teamId)
    : localDesignatedRequirement(identifier, identity.certificateSha1);
  return {
    sign: ['--force', '--timestamp=none', '--options', 'runtime', '--sign', identity.certificateSha1,
      '--keychain', identity.keychainPath, '--identifier', identifier, '--requirements', `=designated => ${requirement}`],
    verify: ['--verify', '--strict', '-R', `=${requirement}`],
  };
}

export function verifyAppleDevelopmentSignature(targetPath, identifier, teamId, runCommand = run) {
  const requirement = appleDevelopmentRequirement(identifier, teamId);
  // Validate Apple's chain and certificate types before trusting the displayed OU/TeamIdentifier.
  runCommand('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, targetPath]);
  const observed = runCommand('/usr/bin/codesign', ['-d', '--verbose=2', targetPath]);
  if (/(?:^|\n)TeamIdentifier=([^\r\n]+)/.exec(observed)?.[1] !== teamId) {
    throw new Error(`Apple development TeamIdentifier mismatch: ${targetPath}`);
  }
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
  const display = nativeCommand('/usr/bin/codesign', ['-d', '--verbose=2', targetPath], { encoding: 'utf8' });
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
    if (identity.signingKind === 'apple-development') {
      verifyAppleDevelopmentSignature(target.path, identifier, identity.teamId);
    } else run('/usr/bin/codesign', [...verify, target.path]);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  verifyMacContactsPermissions(appPath);
  return { mode: 'local-only', certificateSha1: identity.certificateSha1,
    ...(identity.signingKind === 'apple-development' ? { signingKind: identity.signingKind, teamId: identity.teamId } : {}) };
}
