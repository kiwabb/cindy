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

int main(int argc, char **argv) {
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
