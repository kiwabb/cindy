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

  it('blocks actual bundle executables, ignores a reused outside PID, and treats a zombie as exited', async () => {
    const bundle = path.join(fs.realpathSync(root), 'process-fixture');
    const executable = path.join(bundle, 'Contents/Frameworks/Renderer');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync('/bin/sleep', executable); fs.chmodSync(executable, 0o700);
    const renderer = spawn(executable, ['15']); children.push(renderer);
    const status = (pid: number, birth: string) => spawnSync(helper,
      ['--bundle-status', bundle, String(pid), birth], { encoding: 'utf8' });
    await expect.poll(() => status(2147483647, '-').status).toBe(75);
    const blocked = JSON.parse(status(2147483647, '-').stdout);
    expect(blocked.processes).toContainEqual(expect.objectContaining({ pid: renderer.pid, executable: 'Contents/Frameworks/Renderer', zombie: false }));
    const exited = new Promise(resolve => renderer.once('exit', resolve));
    renderer.kill('SIGKILL'); await exited;
    const reused = status(process.pid, '1:2');
    expect(reused.status).toBe(0);
    expect(JSON.parse(reused.stdout).processes).toContainEqual(expect.objectContaining({ pid: process.pid, oldIdentityMatches: false }));
    const parentSource = path.join(root, 'zombie-parent.c'), parentExe = path.join(root, 'zombie-parent');
    fs.writeFileSync(parentSource, String.raw`
#include <unistd.h>
#include <stdio.h>
#include <sys/wait.h>
#include <signal.h>

static volatile sig_atomic_t done = 0;
static void stop(int signal_number) { (void)signal_number; done = 1; }

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  signal(SIGTERM, stop);
  pid_t child = fork();
  if (child == 0) {
    execl(argv[1], argv[1], "0", NULL);
    _exit(1);
  }
  printf("%d\n", child);
  fflush(stdout);
  while (!done) sleep(1);
  waitpid(child, NULL, 0);
  return 0;
}
`);
    expect(spawnSync('/usr/bin/xcrun', ['clang', parentSource, '-o', parentExe]).status).toBe(0);
    const parent = spawn(parentExe, [executable]); children.push(parent);
    const zombiePid = await new Promise<number>(resolve => parent.stdout.once('data', data => resolve(Number(String(data).trim()))));
    try {
      await expect.poll(() => {
        const result = status(zombiePid, '-');
        return JSON.parse(result.stdout).processes.some((value: { pid: number; zombie: boolean }) => value.pid === zombiePid && value.zombie);
      }).toBe(true);
      expect(status(zombiePid, '-').status).toBe(0);
      expect(spawnSync('/bin/kill', ['-0', String(zombiePid)]).status).toBe(0);
    } finally {
      const stopped = new Promise(resolve => parent.once('exit', resolve)); parent.kill('SIGTERM'); await stopped;
    }
  });

  it('bounds its own command group timeout', () => {
    const result = spawnSync(helper, ['--run', String(process.pid), '1', '/bin/sleep', '15'], { timeout: 4_000 });
    expect(result.status).toBe(124);
  });
});
