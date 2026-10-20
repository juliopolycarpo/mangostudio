// Linux x64 syscall fault injection for a child owned by this test.
// Child-ENOENT reproduction mechanism: https://github.com/oven-sh/bun/pull/35800
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(const char *operation) {
  perror(operation);
  exit(125);
}

static int is_target(pid_t pid, unsigned long address) {
  char path[256] = {0};
  for (size_t offset = 0; offset < sizeof(path) - sizeof(long); offset += sizeof(long)) {
    errno = 0;
    long word = ptrace(PTRACE_PEEKDATA, pid, address + offset, 0);
    if (errno) fail("PTRACE_PEEKDATA");
    memcpy(path + offset, &word, sizeof(word));
    if (memchr(&word, 0, sizeof(word))) break;
  }
  const char *name = strrchr(path, '/');
  return strcmp(name ? name + 1 : path, "raced-child") == 0;
}

int main(int argc, char **argv) {
  if (argc < 3) return 125;
  int denied = strcmp(argv[1], "EACCES") == 0;
  pid_t child = fork();
  if (child < 0) fail("fork");
  if (child == 0) {
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) < 0) fail("PTRACE_TRACEME");
    raise(SIGSTOP);
    execvp(argv[2], argv + 2);
    fail("execvp");
  }
  int status;
  if (waitpid(child, &status, 0) != child) fail("waitpid initial stop");
  if (!WIFSTOPPED(status)) return 125;
  if (ptrace(PTRACE_SETOPTIONS, child, 0,
             PTRACE_O_TRACESYSGOOD | PTRACE_O_TRACECLONE | PTRACE_O_EXITKILL) < 0)
    fail("PTRACE_SETOPTIONS");
  if (ptrace(PTRACE_SYSCALL, child, 0, 0) < 0) fail("PTRACE_SYSCALL initial");

  // Each worker can have one unlink in flight. Cap the trace to 128 thread IDs.
  struct { pid_t pid; int target; } threads[128] = {0};
  int result = 125;
  pid_t pid;
  while ((pid = waitpid(-1, &status, __WALL)) > 0) {
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      if (pid == child)
        result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      continue;
    }
    int signal = WSTOPSIG(status);
    if (signal == (SIGTRAP | 0x80)) {
      size_t slot = 0;
      while (slot < 128 && threads[slot].pid != 0 && threads[slot].pid != pid) slot++;
      if (slot == 128) { errno = E2BIG; fail("traced thread limit"); }
      threads[slot].pid = pid;
      struct __ptrace_syscall_info info;
      if (ptrace(PTRACE_GET_SYSCALL_INFO, pid, sizeof(info), &info) < 0)
        fail("PTRACE_GET_SYSCALL_INFO");
      if (info.op == PTRACE_SYSCALL_INFO_ENTRY) {
        unsigned long path = info.entry.nr == SYS_unlinkat ? info.entry.args[1]
                           : info.entry.nr == SYS_unlink ? info.entry.args[0] : 0;
        threads[slot].target = path && is_target(pid, path);
        if (threads[slot].target && denied) {
          struct user_regs_struct regs;
          if (ptrace(PTRACE_GETREGS, pid, 0, &regs) < 0) fail("PTRACE_GETREGS entry");
          regs.orig_rax = -1; // Do not delete the denied child.
          if (ptrace(PTRACE_SETREGS, pid, 0, &regs) < 0) fail("PTRACE_SETREGS entry");
        }
      } else if (info.op == PTRACE_SYSCALL_INFO_EXIT && threads[slot].target) {
        threads[slot].target = 0;
        if (denied || info.exit.rval == 0) {
          struct user_regs_struct regs;
          if (ptrace(PTRACE_GETREGS, pid, 0, &regs) < 0) fail("PTRACE_GETREGS exit");
          regs.rax = denied ? -EACCES : -ENOENT;
          if (ptrace(PTRACE_SETREGS, pid, 0, &regs) < 0) fail("PTRACE_SETREGS exit");
          fprintf(stderr, "injected child %s\n", denied ? "EACCES" : "ENOENT");
        }
      }
    }
    int deliver = signal == SIGSTOP || signal == SIGTRAP || signal == (SIGTRAP | 0x80)
                    ? 0 : signal;
    if (ptrace(PTRACE_SYSCALL, pid, 0, deliver) < 0 && errno != ESRCH)
      fail("PTRACE_SYSCALL resume");
  }
  if (errno != ECHILD) fail("waitpid trace");
  return result;
}
