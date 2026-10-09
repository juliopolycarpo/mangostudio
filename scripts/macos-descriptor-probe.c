#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

struct measurement {
  long long nanoseconds;
  int census_bytes;
  int closed;
  int high_closed;
  int preserved;
};

static long long monotonic(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) _exit(90);
  return (long long)value.tv_sec * 1000000000LL + value.tv_nsec;
}

static int kept(int fd, int result_pipe) {
  return fd == result_pipe || fd == STDOUT_FILENO || fd == STDERR_FILENO;
}

static void measure(int census, int high, long limit, int trial) {
  int pipe_fds[2];
  if (pipe(pipe_fds) != 0) exit(91);
  int high_fd = -1;
  if (high) {
    high_fd = fcntl(STDOUT_FILENO, F_DUPFD, 65536);
    if (high_fd < 0) {
      perror("create high descriptor");
      exit(92);
    }
  }
  pid_t child = fork();
  if (child < 0) exit(93);
  if (child == 0) {
    struct measurement result = {0};
    struct proc_fdinfo descriptors[256];
    long long start = monotonic();
    if (census) {
      result.census_bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0,
                                       descriptors, sizeof(descriptors));
      if (result.census_bytes <= 0 ||
          result.census_bytes >= (int)sizeof(descriptors) ||
          result.census_bytes % (int)sizeof(descriptors[0]) != 0) _exit(94);
      int count = result.census_bytes / sizeof(descriptors[0]);
      for (int index = 0; index < count; index++) {
        int fd = descriptors[index].proc_fd;
        if (fd < 0 || (index && descriptors[index - 1].proc_fd >= fd)) _exit(95);
      }
      for (int index = 0; index < count; index++) {
        int fd = descriptors[index].proc_fd;
        if (!kept(fd, pipe_fds[1])) {
          if (close(fd) != 0) _exit(96);
          result.closed++;
        }
      }
    } else {
      for (int fd = 0; fd < limit; fd++) {
        if (!kept(fd, pipe_fds[1])) {
          close(fd);
          result.closed++;
        }
      }
    }
    result.nanoseconds = monotonic() - start;
    result.preserved = fcntl(pipe_fds[1], F_GETFD) >= 0 &&
                       fcntl(STDOUT_FILENO, F_GETFD) >= 0 &&
                       fcntl(STDERR_FILENO, F_GETFD) >= 0;
    result.high_closed = high_fd < 0 ||
                        (fcntl(high_fd, F_GETFD) < 0 && errno == EBADF);
    if (write(pipe_fds[1], &result, sizeof(result)) != (ssize_t)sizeof(result)) _exit(97);
    _exit(0);
  }
  close(pipe_fds[1]);
  if (high_fd >= 0) close(high_fd);
  struct measurement result;
  ssize_t received = read(pipe_fds[0], &result, sizeof(result));
  close(pipe_fds[0]);
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
      WEXITSTATUS(status) != 0 || received != (ssize_t)sizeof(result)) exit(98);
  printf("{\"mode\":\"%s\",\"trial\":%d,\"openMax\":%ld,\"nanoseconds\":%lld,\"censusBytes\":%d,\"closeCalls\":%d,\"highFd\":%d,\"highClosed\":%s,\"keepPreserved\":%s}\n",
         census ? "child-census" : "original-range", trial, limit,
         result.nanoseconds, result.census_bytes, result.closed, high_fd,
         result.high_closed ? "true" : "false",
         result.preserved ? "true" : "false");
  if (!result.high_closed || !result.preserved) exit(99);
}

int main(void) {
  long limit = sysconf(_SC_OPEN_MAX);
  struct rlimit resource;
  if (limit <= 0 || getrlimit(RLIMIT_NOFILE, &resource) != 0) return 89;
  printf("{\"host\":\"darwin\",\"openMax\":%ld,\"rlimCur\":%llu,\"rlimMax\":%llu}\n",
         limit, (unsigned long long)resource.rlim_cur,
         (unsigned long long)resource.rlim_max);
  fflush(stdout);
  for (int trial = 0; trial < 5; trial++) {
    measure(0, 0, limit, trial);
    measure(1, 0, limit, trial);
  }
  measure(1, 1, limit, 5);
  return 0;
}
