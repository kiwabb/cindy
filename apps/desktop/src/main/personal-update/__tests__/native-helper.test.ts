import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'darwin')('personal updater native kernel boundaries', () => {
  let root: string, helper: string;
  const children: ChildProcess[] = [];
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-native-test-'));
    helper = path.join(root, 'swap-apps');
    const source = path.resolve(import.meta.dirname, '../../../../native/personal-update/swap-apps.c');
    const build = spawnSync('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', source, '-o', helper], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
  });
  afterAll(() => {
    for (const child of children) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exchanges and restores two real directories while refusing a symlink', () => {
    const first = path.join(root, 'canonical'), second = path.join(root, 'candidate');
    fs.mkdirSync(first); fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'old'), 'old'); fs.writeFileSync(path.join(second, 'new'), 'new');
    expect(spawnSync(helper, [first, second]).status).toBe(0);
    expect(fs.readFileSync(path.join(first, 'new'), 'utf8')).toBe('new');
    expect(spawnSync(helper, [first, second]).status).toBe(0);
    expect(fs.readFileSync(path.join(first, 'old'), 'utf8')).toBe('old');
    const link = path.join(root, 'link'); fs.symlinkSync(first, link);
    expect(spawnSync(helper, [link, second]).status).toBe(2);
  });

  it('holds one kernel lock across exec and releases it on owner death without PID assumptions', async () => {
    const script = path.join(root, 'holder.sh'), ready = path.join(root, 'locked');
    fs.writeFileSync(script, `echo ready > '${ready}'\nexec /bin/sleep 15\n`);
    const args = ['--lock', path.join(root, 'process.lock'), script];
    const holder = spawn(helper, args); children.push(holder);
    await expect.poll(() => fs.existsSync(ready)).toBe(true);
    expect(spawnSync(helper, args).status).toBe(75);
    const exited = new Promise(resolve => holder.once('exit', resolve));
    holder.kill('SIGKILL'); await exited;
    const short = path.join(root, 'short.sh'); fs.writeFileSync(short, 'exit 0\n');
    expect(spawnSync(helper, ['--lock', path.join(root, 'process.lock'), short]).status).toBe(0);
  });

  it('cleans only its own child when the worker parent disappears', async () => {
    const childPidFile = path.join(root, 'supervised-child.pid');
    const script = path.join(root, 'worker-parent.sh');
    fs.writeFileSync(script, `'${helper}' --run $$ 15 /bin/sh -c 'echo $$ > "${childPidFile}"; exec /bin/sleep 15' &\n/bin/sleep 1\nexit 0\n`);
    const worker = spawn('/bin/sh', [script]); children.push(worker);
    await expect.poll(() => fs.existsSync(childPidFile)).toBe(true);
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8').trim());
    expect(childPid).toBeGreaterThan(1);
    await new Promise(resolve => worker.once('exit', resolve));
    await expect.poll(() => {
      try { process.kill(childPid, 0); return true; } catch { return false; }
    }).toBe(false);
  });

  it('reclaims its own background group even when the command root exits successfully', async () => {
    const pidFile = path.join(root, 'background.pid');
    const result = spawnSync(helper, ['--run', String(process.pid), '5', '/bin/sh', '-c',
      `/bin/sleep 15 & echo $! > '${pidFile}'; exit 0`], { timeout: 3_000 });
    expect(result.status).toBe(0);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }).toBe(false);
  });

  it('bounds its own command group timeout', () => {
    const result = spawnSync(helper, ['--run', String(process.pid), '1', '/bin/sleep', '15'], { timeout: 4_000 });
    expect(result.status).toBe(124);
  });
});
