import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { validatePersonalManifest, validatePersonalIdentity, type PersonalPolicy, type PersonalManifest } from './contract.mjs';
import { validateUpdateZip, verifyExtractedTree, readWindowsUpdateZip } from './archive.js';
import { readLocalSigningIdentity, signLocalMacApp, writeMacEntitlements, verifyAppleDevelopmentSignature, withLocalSigningCommandRunner, readLocalSigningIdentifier } from './signing-core.mjs';

export function validPersonalSmokeReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as { ok?: unknown; schema_version?: unknown; tables?: Record<string, unknown> };
  return receipt.ok === true && Number.isSafeInteger(receipt.schema_version) && Number(receipt.schema_version) >= 0
    && receipt.tables?.sessions === 0 && receipt.tables?.messages === 0
    && Number.isSafeInteger(receipt.tables?.migration_meta) && Number(receipt.tables?.migration_meta) >= 0;
}

export function fileSha256(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(1024 * 1024);
    let size: number;
    while ((size = fs.readSync(fd, bytes, 0, bytes.length, null))) hash.update(bytes.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function command(exe: string, args: string[], helper: string): void {
  const result = spawnSync(helper, ['--run', String(process.pid), '120', exe, ...args], { encoding: 'utf8', timeout: 130_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`PERSONAL_UPDATE_COMMAND_FAILED:${path.basename(exe)}`);
}

/** Execute the application's official smoke entry with an empty, isolated userData. */
async function smoke(appPath: string, helper: string, jobDirectory: string): Promise<void> {
  const userData = path.join(jobDirectory, 'smoke-user-data');
  fs.mkdirSync(userData, { mode: 0o700 });
  try {
    await new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(helper, ['--run', String(process.pid), '60', path.join(appPath, 'Contents', 'MacOS', 'Cindy'), '--smoke-test', '--smoke-user=__smoke_test__', `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', tooLarge = false;
      // The native supervisor owns timeout/parent-death cleanup of this child tree.
      const timer = setTimeout(() => { tooLarge = true; }, 65_000);
      child.stdout.on('data', data => {
        if (stdout.length + data.length > 256 * 1024) { tooLarge = true; }
        else stdout += data.toString();
      });
      child.stderr.resume();
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        const success = stdout.split(/\r?\n/).some(line => {
          try { return validPersonalSmokeReceipt(JSON.parse(line)); }
          catch { return false; }
        });
        if (code === 0 && success && !tooLarge) resolve();
        else reject(new Error('PERSONAL_UPDATE_SIGNED_SMOKE_FAILED'));
      });
    });
  } finally { fs.rmSync(userData, { recursive: true, force: true }); }
}

export interface PreparationRequest {
  archive: string; outputDirectory: string; jobDirectory: string; manifest: PersonalManifest; policy: PersonalPolicy; storageIdentity: string;
}

/** Windows has no re-signing or smoke step: verify bytes and structure, then publish the exact ZIP. */
export function prepareWindowsPersonalUpdate(request: PreparationRequest) {
  const manifest = validatePersonalManifest(request.manifest, request.policy);
  if (manifest.storageIdentity !== request.storageIdentity) throw new Error('PERSONAL_UPDATE_STORAGE_INCOMPATIBLE');
  if (fs.statSync(request.archive).size !== manifest.asset.size || fileSha256(request.archive) !== manifest.asset.sha256) throw new Error('PERSONAL_UPDATE_ARCHIVE_HASH');
  fs.mkdirSync(request.outputDirectory, { recursive: true, mode: 0o700 });
  if (request.jobDirectory !== path.join(request.outputDirectory, path.basename(request.jobDirectory))
    || !/^job-[a-f0-9-]{36}$/.test(path.basename(request.jobDirectory))
    || fs.lstatSync(request.jobDirectory).isSymbolicLink()) throw new Error('PERSONAL_UPDATE_JOB_INVALID');
  const metadata = readWindowsUpdateZip(request.archive) as { sourceCommit?: unknown; personalUpdate?: unknown };
  const identity = validatePersonalIdentity(metadata?.personalUpdate, request.policy);
  if (!isDeepStrictEqual(identity, validatePersonalIdentity(manifest, request.policy)) || metadata.sourceCommit !== identity.sourceCommit) throw new Error('PERSONAL_UPDATE_SOURCE_MISMATCH');
  const output = path.join(request.outputDirectory, `personal-${manifest.revision}.zip`);
  fs.renameSync(request.archive, output);
  return { path: output, sha256: manifest.asset.sha256, size: manifest.asset.size, identity };
}

export async function preparePersonalUpdate(request: PreparationRequest) {
  if (process.platform === 'win32') return prepareWindowsPersonalUpdate(request);
  process.env.CINDY_UPDATE_SUPERVISOR_LEDGER = path.join(request.jobDirectory, 'supervisors');
  const helper = '/Applications/Cindy.app/Contents/Resources/tools/personal-update/swap-apps';
  const signing = readLocalSigningIdentity();
  const teamId = signing.teamId;
  if (signing.signingKind !== 'apple-development' || typeof teamId !== 'string') throw new Error('PERSONAL_UPDATE_REQUIRES_APPLE_DEVELOPMENT');
  verifyAppleDevelopmentSignature('/Applications/Cindy.app', 'com.xd.cindy', teamId);
  verifyAppleDevelopmentSignature(helper, readLocalSigningIdentifier(helper, '/Applications/Cindy.app'), teamId);
  const manifest = validatePersonalManifest(request.manifest, request.policy);
  if (manifest.storageIdentity !== request.storageIdentity) throw new Error('PERSONAL_UPDATE_STORAGE_INCOMPATIBLE');
  if (fs.statSync(request.archive).size !== manifest.asset.size || fileSha256(request.archive) !== manifest.asset.sha256) throw new Error('PERSONAL_UPDATE_ARCHIVE_HASH');
  validateUpdateZip(request.archive);
  fs.mkdirSync(request.outputDirectory, { recursive: true, mode: 0o700 });
  if (request.jobDirectory !== path.join(request.outputDirectory, path.basename(request.jobDirectory))
    || !/^job-[a-f0-9-]{36}$/.test(path.basename(request.jobDirectory))
    || fs.lstatSync(request.jobDirectory).isSymbolicLink()) throw new Error('PERSONAL_UPDATE_JOB_INVALID');
  const staging = path.join(request.jobDirectory, 'stage');
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    command('/usr/bin/ditto', ['-x', '-k', request.archive, staging], helper);
    const appPath = path.join(staging, 'Cindy.app');
    verifyExtractedTree(appPath);
    const metadata = JSON.parse(fs.readFileSync(path.join(appPath, 'Contents', 'Resources', 'cindy-source.json'), 'utf8'));
    const identity = validatePersonalIdentity(metadata.personalUpdate, request.policy);
    if (JSON.stringify(identity) !== JSON.stringify(validatePersonalIdentity(manifest, request.policy)) || metadata.sourceCommit !== identity.sourceCommit) throw new Error('PERSONAL_UPDATE_SOURCE_MISMATCH');
    const bundle = spawnSync(helper, ['--run', String(process.pid), '30', '/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 40_000 });
    if (bundle.status !== 0 || bundle.stdout.trim() !== manifest.bundleIdentifier) throw new Error('PERSONAL_UPDATE_BUNDLE');
    const architecture = spawnSync(helper, ['--run', String(process.pid), '30', '/usr/bin/lipo', '-archs', path.join(appPath, 'Contents', 'MacOS', 'Cindy')], { encoding: 'utf8', timeout: 40_000 });
    if (architecture.status !== 0 || architecture.stdout.trim() !== 'arm64') throw new Error('PERSONAL_UPDATE_ARCH');
    const helperEntitlements = path.join(staging, 'helper.plist'), mainEntitlements = path.join(staging, 'main.plist');
    writeMacEntitlements(helperEntitlements);
    writeMacEntitlements(mainEntitlements, { appleEvents: true });
    const deadline = Date.now() + 25 * 60_000;
    withLocalSigningCommandRunner((exe, args, options) => {
      const seconds = Math.min(120, Math.floor((deadline - Date.now()) / 1000));
      if (seconds < 1) throw new Error('PERSONAL_UPDATE_SIGNING_TIMEOUT');
      return spawnSync(helper, ['--run', String(process.pid), String(seconds), exe, ...args],
        { ...options, timeout: (seconds + 10) * 1000, killSignal: 'SIGTERM', maxBuffer: 64 * 1024 * 1024 });
    }, () => signLocalMacApp(appPath, helperEntitlements, mainEntitlements, signing));
    await smoke(appPath, helper, request.jobDirectory);
    const output = path.join(request.outputDirectory, `personal-${manifest.revision}.zip`);
    const temporary = path.join(staging, 'signed.zip');
    command('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, temporary], helper);
    const sha256 = fileSha256(temporary), size = fs.statSync(temporary).size;
    fs.renameSync(temporary, output);
    return { path: output, sha256, size, identity, teamId };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

const port = (process as unknown as { parentPort?: { once: (event: string, handler: (event: { data: PreparationRequest }) => void) => void; postMessage: (data: unknown) => void } }).parentPort;
port?.once('message', event => {
  void preparePersonalUpdate(event.data).then(result => { port.postMessage({ ok: true, result }); }, () => { port.postMessage({ ok: false, error: 'PERSONAL_UPDATE_PREPARATION_FAILED' }); });
});
