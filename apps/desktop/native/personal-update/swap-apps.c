#include <stdio.h>
#include <sys/stat.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>
#include <libproc.h>
#include <limits.h>
#include <dirent.h>
#include <sys/proc.h>
#include <sys/sysctl.h>

/* Atomic same-volume exchange keeps the canonical application present even
 * across power loss. No deletion, process control, or credential access. */
static volatile sig_atomic_t cancelled = 0;
static void cancel_command(int signal_number) { (void)signal_number; cancelled = 1; }

static void terminate_children(pid_t parent) {
  int bytes = proc_listchildpids(parent, NULL, 0);
  if (bytes <= 0 || bytes > 1024 * 1024) return;
  pid_t *children = calloc(1, (size_t)bytes);
  if (!children) return;
  int count = proc_listchildpids(parent, children, bytes) / (int)sizeof(pid_t);
  for (int index = 0; index < count; index++) {
    if (children[index] <= 1) continue;
    terminate_children(children[index]);
    kill(children[index], SIGKILL);
  }
  free(children);
}

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *byte = (const unsigned char *)value; *byte; byte++) {
    if (*byte == '"' || *byte == '\\') { putchar('\\'); putchar(*byte); }
    else if (*byte < 32) printf("\\u%04x", *byte);
    else putchar(*byte);
  }
  putchar('"');
}

static int read_process_info(pid_t pid, struct proc_bsdinfo *info) {
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info)) return 1;
  /* libproc can omit zombies. sysctl retains their identity until the parent reaps them. */
  struct kinfo_proc process;
  size_t size = sizeof(process);
  int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  if (sysctl(query, 4, &process, &size, NULL, 0) != 0 || size != sizeof(process) || process.kp_proc.p_stat != SZOMB) return 0;
  memset(info, 0, sizeof(*info));
  info->pbi_ppid = process.kp_eproc.e_ppid;
  info->pbi_status = SZOMB;
  info->pbi_start_tvsec = process.kp_proc.p_starttime.tv_sec;
  info->pbi_start_tvusec = process.kp_proc.p_starttime.tv_usec;
  return 1;
}

/* Read only kernel process identity. Never inspect arguments or environment. */
static int bundle_status(const char *bundle, pid_t old_pid, const char *expected_birth) {
  size_t prefix_length = strlen(bundle);
  if (!prefix_length || bundle[0] != '/' || bundle[prefix_length - 1] == '/') return 2;
  int capacity = proc_listallpids(NULL, 0) + 256;
  if (capacity <= 256 || capacity > 65536) return 2;
  pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
  if (!pids) return 2;
  int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
  if (count <= 0 || count >= capacity) { free(pids); return 2; }
  int old_listed = 0;
  for (int index = 0; index < count; index++) if (pids[index] == old_pid) old_listed = 1;
  if (!old_listed) pids[count++] = old_pid;
  int blocking = 0, recorded = 0, unknown = 0;
  printf("{\"schemaVersion\":1,\"processes\":[");
  for (int index = 0; index < count; index++) {
    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int has_path = proc_pidpath(pids[index], executable, sizeof(executable)) > 0;
    int in_bundle = has_path && strncmp(executable, bundle, prefix_length) == 0 && executable[prefix_length] == '/';
    struct proc_bsdinfo info;
    if (!read_process_info(pids[index], &info)) {
      if (in_bundle || (pids[index] == old_pid && (kill(old_pid, 0) == 0 || errno == EPERM))) {
        unknown = blocking = 1;
        if (recorded < 64) {
          if (recorded++) putchar(',');
          printf("{\"pid\":%d,\"ppid\":null,\"state\":null,\"birth\":null,\"executable\":", pids[index]);
          json_string(in_bundle ? executable + prefix_length + 1 : "<unavailable>");
          putchar('}');
        }
      }
      continue;
    }
    char birth[64];
    snprintf(birth, sizeof(birth), "%llu:%llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    int old_matches = pids[index] == old_pid && strcmp(birth, expected_birth) == 0;
    int old_relevant = old_matches || (pids[index] == old_pid && strcmp(expected_birth, "-") == 0);
    if (!in_bundle && pids[index] != old_pid) continue;
    if (info.pbi_status != SZOMB && (in_bundle || (old_relevant && !has_path))) blocking = 1;
    if (old_relevant && !has_path && info.pbi_status != SZOMB) unknown = 1;
    if (recorded >= 64) { blocking = 1; continue; }
    if (recorded++) putchar(',');
    printf("{\"pid\":%d,\"ppid\":%d,\"state\":%u,\"zombie\":%s,\"birth\":", pids[index], info.pbi_ppid, info.pbi_status, info.pbi_status == SZOMB ? "true" : "false");
    json_string(birth);
    printf(",\"oldIdentityMatches\":%s,\"executable\":", old_matches ? "true" : "false");
    json_string(in_bundle ? executable + prefix_length + 1 : "<outside-bundle-or-unavailable>");
    putchar('}');
  }
  printf("],\"blocked\":%s,\"unknown\":%s}\n", blocking ? "true" : "false", unknown ? "true" : "false");
  free(pids);
  return unknown ? 2 : blocking ? 75 : 0;
}

int main(int argc, char **argv) {
  if (argc == 5 && strcmp(argv[1], "--bundle-status") == 0) {
    char *end; long pid = strtol(argv[3], &end, 10);
    if (*end || pid <= 1 || pid > INT_MAX) return 2;
    return bundle_status(argv[2], (pid_t)pid, argv[4]);
  }
  if (argc == 3 && strcmp(argv[1], "--pid-birth") == 0) {
    char *end; long pid = strtol(argv[2], &end, 10);
    struct proc_bsdinfo info;
    if (*end || pid <= 1 || proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 1;
    printf("%llu:%llu\n", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "--job-idle") == 0) {
    DIR *directory = opendir(argv[2]);
    if (!directory) return errno == ENOENT ? 0 : 1;
    struct dirent *entry;
    int result = 0;
    while ((entry = readdir(directory))) {
      if (entry->d_name[0] == '.') continue;
      int pid, consumed = 0;
      if (sscanf(entry->d_name, "supervisor-%d.lock%n", &pid, &consumed) != 1 || entry->d_name[consumed] != '\0' || pid <= 1) { result = 1; break; }
      int fd = openat(dirfd(directory), entry->d_name, O_RDWR | O_NOFOLLOW);
      struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET };
      if (fd < 0 || fcntl(fd, F_SETLK, &lock) < 0) { if (fd >= 0) close(fd); result = 75; break; }
      close(fd);
    }
    closedir(directory);
    return result;
  }
  if (argc == 3 && strcmp(argv[1], "--sync") == 0) {
    int fd = open(argv[2], O_RDONLY | O_NOFOLLOW);
    if (fd < 0 || fsync(fd) != 0) return 1;
    close(fd);
    char parent[PATH_MAX];
    if (strlen(argv[2]) >= sizeof(parent)) return 2;
    strcpy(parent, argv[2]);
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent) return 2;
    *slash = '\0';
    fd = open(parent, O_RDONLY);
    if (fd < 0 || fsync(fd) != 0) return 1;
    close(fd);
    return 0;
  }
  if (argc >= 5 && strcmp(argv[1], "--run") == 0) {
    signal(SIGTERM, cancel_command);
    signal(SIGINT, cancel_command);
    signal(SIGHUP, cancel_command);
    const char *ledger = getenv("CINDY_UPDATE_SUPERVISOR_LEDGER");
    if (ledger) {
      int directory = open(ledger, O_RDONLY | O_NOFOLLOW);
      if (directory < 0) return 2;
      char name[64]; snprintf(name, sizeof(name), "supervisor-%d.lock", getpid());
      int lease = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
      close(directory);
      struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET };
      if (lease < 0 || fcntl(lease, F_SETLK, &lock) < 0) return 2;
      /* Keep the lease until this supervisor has reaped its command tree. */
    }
    char *end;
    long parent = strtol(argv[2], &end, 10);
    if (*end || parent <= 1 || parent != getppid()) return 2;
    long timeout = strtol(argv[3], &end, 10);
    if (*end || timeout < 1 || timeout > 1200 || argv[4][0] != '/') return 2;
    pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) { setpgid(0, 0); execv(argv[4], &argv[4]); _exit(127); }
    setpgid(child, child);
    struct timespec started, now;
    clock_gettime(CLOCK_MONOTONIC, &started);
    int status;
    for (;;) {
      siginfo_t completion;
      memset(&completion, 0, sizeof(completion));
      if (waitid(P_PID, (id_t)child, &completion, WEXITED | WNOHANG | WNOWAIT) < 0) return 1;
      if (completion.si_pid == child) {
        /* Keep the root PID reserved until its remaining group is terminated.
         * A successful command may have left background descendants behind. */
        terminate_children(child);
        kill(-child, SIGKILL);
        if (waitpid(child, &status, 0) != child) return 1;
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      }
      clock_gettime(CLOCK_MONOTONIC, &now);
      if (cancelled || getppid() != parent || now.tv_sec - started.tv_sec >= timeout) {
        terminate_children(child);
        kill(-child, SIGKILL);
        kill(child, SIGKILL);
        waitpid(child, &status, 0);
        return 124;
      }
      usleep(100000);
    }
  }
  if ((argc >= 4 && strcmp(argv[1], "--lock") == 0) || (argc == 3 && strcmp(argv[1], "--hold-lock") == 0)) {
    int fd = open(argv[2], O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET };
    if (fd < 0 || fcntl(fd, F_SETLK, &lock) < 0) return 75;
    if (strcmp(argv[1], "--hold-lock") == 0) {
      if (write(STDOUT_FILENO, "READY\n", 6) != 6) return 1;
      char byte;
      while (read(STDIN_FILENO, &byte, 1) > 0) {}
      close(fd);
      return 0;
    }
    /* The descriptor deliberately survives exec so the kernel owns the lease.
     * A crash or PID reuse cannot admit two transaction monitors. */
    argv[2] = "/bin/bash";
    execv("/bin/bash", &argv[2]);
    return 1;
  }
  struct stat first, second;
  if (argc != 3 || lstat(argv[1], &first) || lstat(argv[2], &second)
      || !S_ISDIR(first.st_mode) || !S_ISDIR(second.st_mode)
      || first.st_dev != second.st_dev || strcmp(argv[1], argv[2]) == 0) {
    fprintf(stderr, "Invalid application exchange paths\n");
    return 2;
  }
  if (renamex_np(argv[1], argv[2], RENAME_SWAP) != 0) {
    fprintf(stderr, "Application exchange failed (%d)\n", errno);
    return 1;
  }
  char parent[PATH_MAX];
  if (strlen(argv[1]) >= sizeof(parent)) return 1;
  strcpy(parent, argv[1]);
  char *slash = strrchr(parent, '/');
  if (!slash || slash == parent) return 1;
  *slash = '\0';
  int directory = open(parent, O_RDONLY);
  if (directory < 0 || fsync(directory) != 0) return 1;
  close(directory);
  return 0;
}
