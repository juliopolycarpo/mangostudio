/**
 * Abstraction over OS process signals so commands stay testable without
 * sending real signals. Cross-platform via Node/Bun's process.kill mapping.
 */

export interface ProcessController {
  /** True when the pid refers to a live process. */
  isAlive(pid: number): boolean;
  /** Request graceful termination (SIGTERM). */
  terminate(pid: number): void;
  /** Force termination (SIGKILL). */
  kill(pid: number): void;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Real controller backed by process.kill. // Usage: createProcessController() */
export function createProcessController(): ProcessController {
  return {
    isAlive,
    terminate: (pid) => signal(pid, 'SIGTERM'),
    kill: (pid) => signal(pid, 'SIGKILL'),
  };
}

/** Poll until the pid exits or the timeout elapses; true if it exited. */
// Usage: await waitForExit(controller, pid, { timeoutMs: 10_000, intervalMs: 200, now, sleep });
export async function waitForExit(
  controller: ProcessController,
  pid: number,
  opts: WaitOptions
): Promise<boolean> {
  const deadline = opts.now() + opts.timeoutMs;
  while (opts.now() < deadline) {
    if (!controller.isAlive(pid)) {
      return true;
    }
    await opts.sleep(opts.intervalMs);
  }
  return !controller.isAlive(pid);
}

/** Signal 0 probes existence; EPERM means alive-but-not-ours, ESRCH means dead. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, sig);
  } catch (error) {
    // Already gone (ESRCH) is fine; rethrow anything else (e.g. EPERM).
    if ((error as { code?: string }).code !== 'ESRCH') {
      throw error;
    }
  }
}
