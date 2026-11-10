import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { validatePersonalIdentity, resolvePersonalPolicy, type PersonalIdentity, type PersonalPolicy } from './contract.mjs';
import { appleDevelopmentRequirement } from './signing-core.mjs';
import type { PersonalJournal } from './transaction.js';
import policyValue from '../../../personal-update-channel.json';

export interface CommittedPersonalUpdateReceipt extends PersonalJournal {
  phase: 'committed';
  extract: string;
  attempt: string;
  script: string;
}

export interface PersonalCleanupContext {
  canonicalApp: string;
  teamId: string;
}

const policy = resolvePersonalPolicy(policyValue, 'darwin', 'arm64') as PersonalPolicy;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function readJson(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid cleanup metadata');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function codesign(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(error) : resolve(`${stdout}\n${stderr}`));
  });
}

async function verifyCode(file: string, teamId: string, identifier?: string): Promise<void> {
  const display = await codesign(['-d', '--verbose=4', file]);
  const actualIdentifier = /^Identifier=(.+)$/m.exec(display)?.[1];
  if (!actualIdentifier || (identifier && actualIdentifier !== identifier)
    || !display.split('\n').includes(`TeamIdentifier=${teamId}`)) throw new Error('Cleanup signature mismatch');
  await codesign(['--verify', '--deep', '--strict', '-R', `=${appleDevelopmentRequirement(actualIdentifier, teamId)}`, file]);
}

async function verifyApp(file: string, identity: PersonalIdentity, teamId: string): Promise<void> {
  if (!(await fs.lstat(file)).isDirectory()) throw new Error('Cleanup app must be a real directory');
  await verifyCode(file, teamId, 'com.xd.cindy');
  const metadata = await readJson(path.join(file, 'Contents/Resources/cindy-source.json')) as {
    sourceCommit: string; personalUpdate: unknown;
  };
  if (metadata.sourceCommit !== identity.sourceCommit
    || !isDeepStrictEqual(validatePersonalIdentity(metadata.personalUpdate, policy), identity)) {
    throw new Error('Cleanup app identity mismatch');
  }
}

function validateReceipt(value: unknown, root: string, context: PersonalCleanupContext): CommittedPersonalUpdateReceipt {
  const receipt = value as CommittedPersonalUpdateReceipt;
  const identity = validatePersonalIdentity(receipt?.identity, policy);
  const previous = validatePersonalIdentity(receipt?.previousIdentity, policy);
  if (receipt.schemaVersion !== 1 || receipt.phase !== 'committed' || !uuid.test(receipt.nonce)
    || identity.revision <= previous.revision || identity.storageIdentity !== previous.storageIdentity
    || receipt.canonicalApp !== context.canonicalApp || receipt.teamId !== context.teamId
    || receipt.backup !== path.join(path.dirname(context.canonicalApp), `.Cindy-personal-backup-${receipt.nonce}.app`)
    || receipt.extract !== path.join(root, `extract-${receipt.nonce}`)
    || receipt.attempt !== path.join(root, `attempt-${receipt.nonce}`)
    || receipt.script !== path.join(receipt.attempt, 'apply.sh')
    || receipt.helper !== path.join(receipt.attempt, 'swap-apps')
    || receipt.health !== path.join(root, `health-${receipt.nonce}.json`)
    || receipt.zip !== path.join(root, `personal-${identity.revision}.zip`)
    || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !/^[a-f0-9]{64}$/.test(receipt.helperSha256)
    || !/^[a-f0-9]{64}$/.test(receipt.ownerIdentity)
    || !Number.isSafeInteger(receipt.previousPid) || receipt.previousPid <= 0) throw new Error('Invalid committed receipt');
  return { ...receipt, identity, previousIdentity: previous };
}

async function acquireLease(helper: string, root: string): Promise<ChildProcessWithoutNullStreams | null> {
  const child = spawn(helper, ['--hold-lock', path.join(root, 'transaction-process.lock')], { stdio: 'pipe' });
  return new Promise(resolve => {
    let settled = false;
    const finish = (held: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!held) child.kill();
      resolve(held ? child : null);
    };
    const timer = setTimeout(() => finish(false), 5_000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output === 'READY\n') finish(true);
      else if (output.length >= 6) finish(false);
    });
    child.stderr.resume();
    child.once('error', () => finish(false));
    child.once('exit', () => finish(false));
  });
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function removeOwned(file: string, directory: boolean, lease: ChildProcessWithoutNullStreams): Promise<void> {
  if (lease.exitCode !== null || lease.signalCode !== null || lease.stdin.destroyed) throw new Error('Cleanup lease ended');
  try {
    const stat = await fs.lstat(file);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Cleanup refuses substituted path');
    await fs.rm(file, { recursive: directory });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Retain one verified rollback app and only prune receipt-owned successful work. */
export async function cleanupCommittedPersonalUpdates(root: string, currentIdentity: PersonalIdentity,
  context: PersonalCleanupContext): Promise<void> {
  let lease: ChildProcessWithoutNullStreams | null = null;
  try {
    if (!path.isAbsolute(root) || path.resolve(root) !== root || !path.isAbsolute(context.canonicalApp)
      || path.resolve(context.canonicalApp) !== context.canonicalApp || path.basename(context.canonicalApp) !== 'Cindy.app'
      || !/^[A-Z0-9]{10}$/.test(context.teamId) || !(await fs.lstat(root)).isDirectory()) return;
    const identity = validatePersonalIdentity(currentIdentity, policy);
    await verifyApp(context.canonicalApp, identity, context.teamId);
    const helper = path.join(context.canonicalApp, 'Contents/Resources/tools/personal-update/swap-apps');
    if (!(await fs.lstat(helper)).isFile()) return;
    await verifyCode(helper, context.teamId);
    lease = await acquireLease(helper, root);
    if (!lease) return;
    // The journal is read only after acquiring the transaction's actual OS lease.
    const journal = await readJson(path.join(root, 'transaction.json')) as PersonalJournal;
    const attempt = path.join(root, `attempt-${journal.nonce}`);
    const current = validateReceipt({ ...journal, attempt, script: path.join(attempt, 'apply.sh'),
      extract: path.join(root, `extract-${journal.nonce}`) }, root, context);
    if (!isDeepStrictEqual(current.identity, identity)) return;
    const committed = path.join(root, 'committed');
    if (!(await fs.lstat(committed)).isDirectory()) return;
    const receipts: CommittedPersonalUpdateReceipt[] = [];
    for (const entry of await fs.readdir(committed, { withFileTypes: true })) {
      if (!entry.isFile() || !uuid.test(entry.name.slice(0, -5)) || !entry.name.endsWith('.json')) continue;
      try {
        const receipt = validateReceipt(await readJson(path.join(committed, entry.name)), root, context);
        if (entry.name !== `${receipt.nonce}.json` || receipt.identity.storageIdentity !== identity.storageIdentity
          || receipt.identity.revision > identity.revision
          || (receipt.identity.revision === identity.revision && receipt.nonce !== current.nonce)) continue;
        receipts.push(receipt);
      } catch { /* Unknown and malformed receipts remain available for diagnosis. */ }
    }
    if (!receipts.some(receipt => isDeepStrictEqual(receipt, current))) return;
    receipts.sort((a, b) => b.identity.revision - a.identity.revision);
    let keptBackup = false;
    for (const receipt of receipts) {
      try {
        try {
          await verifyApp(receipt.backup, receipt.previousIdentity, context.teamId);
          if (keptBackup) await removeOwned(receipt.backup, true, lease);
          else keptBackup = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
        // Stream large ZIP hashes without blocking the main event loop.
        try {
          if (!(await fs.lstat(receipt.zip)).isFile() || await hashFile(receipt.zip) !== receipt.sha256) continue;
          await removeOwned(receipt.zip, false, lease);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
        await removeOwned(receipt.extract, true, lease);
        try {
          if (!(await fs.lstat(receipt.helper)).isFile() || await hashFile(receipt.helper) !== receipt.helperSha256) continue;
          await removeOwned(receipt.attempt, true, lease);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
        await removeOwned(receipt.health, false, lease);
        if (receipt.nonce !== current.nonce && (!keptBackup || !(await fs.stat(receipt.backup).catch(() => null)))) {
          await removeOwned(path.join(committed, `${receipt.nonce}.json`), false, lease);
        }
      } catch { /* A changed path is preserved, with its receipt, for explicit review. */ }
    }
  } catch { /* Cleanup must not prevent startup or recover unknown data by deletion. */ }
  finally {
    if (lease) {
      const child = lease;
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    }
  }
}
