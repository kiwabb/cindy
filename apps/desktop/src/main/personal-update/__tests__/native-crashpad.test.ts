import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('releases inherited Crashpad send rights while the real transaction monitor remains alive and holds its lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-native-crashpad-test-'));
  try {
    const helper = path.join(root, 'swap-apps');
    const build = spawnSync('/usr/bin/xcrun', ['clang', '-Wall', '-Werror',
      path.resolve(import.meta.dirname, '../../../../native/personal-update/swap-apps.c'), '-o', helper], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const source = path.join(root, 'mach-parent.c'), executable = path.join(root, 'mach-parent');
    fs.writeFileSync(source, String.raw`
#include <mach/mach.h>
#include <mach/exception_types.h>
#include <mach/thread_status.h>
#include <mach/notify.h>
#include <spawn.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
extern char **environ;
static exception_mask_t crash_mask = EXC_MASK_CRASH | EXC_MASK_RESOURCE | EXC_MASK_GUARD;

static int count_ports(exception_mask_t mask, int current_thread) {
  exception_mask_t masks[EXC_TYPES_COUNT];
  mach_port_t ports[EXC_TYPES_COUNT];
  exception_behavior_t behaviors[EXC_TYPES_COUNT];
  thread_state_flavor_t flavors[EXC_TYPES_COUNT];
  mach_msg_type_number_t count = EXC_TYPES_COUNT;
  mach_port_t thread = mach_thread_self();
  kern_return_t result = current_thread
    ? thread_get_exception_ports(thread, mask, masks, &count, ports, behaviors, flavors)
    : task_get_exception_ports(mach_task_self(), mask, masks, &count, ports, behaviors, flavors);
  mach_port_deallocate(mach_task_self(), thread);
  if (result != KERN_SUCCESS) return -1;
  int found = 0;
  for (unsigned index = 0; index < count; index++) {
    if (ports[index] != MACH_PORT_NULL) {
      found++;
      mach_port_deallocate(mach_task_self(), ports[index]);
    }
  }
  return found;
}

static int set_crash_ports(mach_port_t port) {
  kern_return_t task_result = task_set_exception_ports(mach_task_self(), crash_mask,
      port, EXCEPTION_DEFAULT, THREAD_STATE_NONE);
  mach_port_t thread = mach_thread_self();
  kern_return_t thread_result = thread_set_exception_ports(thread, crash_mask,
      port, EXCEPTION_DEFAULT, THREAD_STATE_NONE);
  mach_port_deallocate(mach_task_self(), thread);
  return task_result == KERN_SUCCESS && thread_result == KERN_SUCCESS;
}

static int new_port(mach_port_t *port, int send_right) {
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, port) != KERN_SUCCESS) return 0;
  return !send_right || mach_port_insert_right(mach_task_self(), *port, *port, MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS;
}

static int held_by(pid_t owner, const char *file) {
  int fd = open(file, O_RDWR);
  if (fd < 0) return 0;
  struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET };
  int held = fcntl(fd, F_GETLK, &lock) == 0 && lock.l_type == F_WRLCK && lock.l_pid == owner;
  close(fd);
  return held;
}

static int notification(mach_port_t port, int timeout) {
  struct { mach_msg_header_t header; char data[256]; } message;
  kern_return_t result = mach_msg(&message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT,
      0, sizeof(message), port, timeout, MACH_PORT_NULL);
  if (result == MACH_RCV_TIMED_OUT) return 0;
  return result == MACH_MSG_SUCCESS && message.header.msgh_id == MACH_NOTIFY_NO_SENDERS ? 1 : -1;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "probe") == 0) {
    int cleared = strcmp(argv[2], "cleared") == 0;
    int task_ports = count_ports(crash_mask, 0), thread_ports = count_ports(crash_mask, 1);
    int unrelated = count_ports(EXC_MASK_BAD_ACCESS, 0), descriptors = 0;
    for (int fd = 3; fd < 256; fd++) if (fcntl(fd, F_GETFD) != -1) descriptors++;
    if (unrelated <= 0 || (cleared ? task_ports != 0 || thread_ports != 0 : task_ports <= 0 || descriptors != 0)) return 10;
    printf("READY task=%d thread=%d unrelated=%d extra_fds=%d\n", task_ports, thread_ports, unrelated, descriptors);
    fflush(stdout);
    char byte;
    read(STDIN_FILENO, &byte, 1);
    return 0;
  }
  if (argc != 5) return 2;
  for (int cleared = 0; cleared < 2; cleared++) {
    mach_port_t crash, unrelated, notify, previous;
    if (!new_port(&crash, 1) || !new_port(&unrelated, 1) || !new_port(&notify, 0)) return 3;
    if (!set_crash_ports(crash) || task_set_exception_ports(mach_task_self(), EXC_MASK_BAD_ACCESS,
        unrelated, EXCEPTION_DEFAULT, THREAD_STATE_NONE) != KERN_SUCCESS) return 4;
    if (mach_port_request_notification(mach_task_self(), crash, MACH_NOTIFY_NO_SENDERS,
        0, notify, MACH_MSG_TYPE_MAKE_SEND_ONCE, &previous) != KERN_SUCCESS) return 5;
    if (previous != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), previous);
    int input[2], output[2];
    if (pipe(input) != 0 || pipe(output) != 0) return 6;
    for (int index = 0; index < 2; index++) {
      fcntl(input[index], F_SETFD, FD_CLOEXEC);
      fcntl(output[index], F_SETFD, FD_CLOEXEC);
    }
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, input[0], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO);
    char *control[] = { "/bin/bash", argv[4], NULL };
    char *wrapped[] = { argv[1], "--lock", argv[2], argv[3], NULL };
    pid_t child;
    int spawned = cleared ? posix_spawn(&child, argv[1], &actions, NULL, wrapped, environ)
      : posix_spawn(&child, "/bin/bash", &actions, NULL, control, environ);
    posix_spawn_file_actions_destroy(&actions);
    close(input[0]); close(output[1]);
    if (spawned != 0) return 7;
    FILE *reader = fdopen(output[0], "r");
    char ready[256];
    if (!fgets(ready, sizeof(ready), reader) || strncmp(ready, "READY ", 6) != 0) return 8;
    printf("%s%s", cleared ? "wrapped " : "control ", ready);
    if (!set_crash_ports(MACH_PORT_NULL)) return 9;
    mach_port_deallocate(mach_task_self(), crash);
    int received = notification(notify, cleared ? 1000 : 200);
    int status;
    if (kill(child, 0) != 0 || waitpid(child, &status, WNOHANG) != 0) return 11;
    if (cleared && (!held_by(child, argv[2]) || received != 1)) return 12;
    if (!cleared && received != 0) return 13;
    printf("%s alive_no_senders=%d lease=%d\n", cleared ? "wrapped" : "control", received, cleared ? held_by(child, argv[2]) : 0);
    close(input[1]);
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 14;
    fclose(reader);
    if (!cleared && notification(notify, 1000) != 1) return 15;
    if (!cleared) puts("control after_exit_no_senders=1");
    task_set_exception_ports(mach_task_self(), EXC_MASK_BAD_ACCESS, MACH_PORT_NULL, EXCEPTION_DEFAULT, THREAD_STATE_NONE);
    mach_port_deallocate(mach_task_self(), unrelated);
    mach_port_mod_refs(mach_task_self(), unrelated, MACH_PORT_RIGHT_RECEIVE, -1);
    mach_port_mod_refs(mach_task_self(), crash, MACH_PORT_RIGHT_RECEIVE, -1);
    mach_port_mod_refs(mach_task_self(), notify, MACH_PORT_RIGHT_RECEIVE, -1);
  }
  return 0;
}
`);
    const compiled = spawnSync('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', source, '-o', executable], { encoding: 'utf8' });
    expect(compiled.status, compiled.stderr).toBe(0);
    // Match production's hardened-runtime option without accessing any identity/keychain.
    for (const binary of [helper, executable]) {
      const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', binary], { encoding: 'utf8' });
      expect(signed.status, signed.stderr).toBe(0);
      const displayed = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', binary], { encoding: 'utf8' });
      expect(displayed.status, displayed.stderr).toBe(0);
      expect(displayed.stderr).toMatch(/flags=.*\bruntime\b/);
    }
    const script = path.join(root, 'mach-probe.sh'), controlScript = path.join(root, 'mach-control.sh');
    fs.writeFileSync(script, `exec '${executable}' probe cleared\n`);
    fs.writeFileSync(controlScript, `exec '${executable}' probe control\n`);
    const result = spawnSync(executable, [helper, path.join(root, 'process.lock'), script, controlScript], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/control READY task=[1-9]\d* .*extra_fds=0/);
    expect(result.stdout).toContain('control alive_no_senders=0 lease=0');
    expect(result.stdout).toContain('control after_exit_no_senders=1');
    expect(result.stdout).toContain('wrapped READY task=0 thread=0 unrelated=1');
    expect(result.stdout).toContain('wrapped alive_no_senders=1 lease=1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
