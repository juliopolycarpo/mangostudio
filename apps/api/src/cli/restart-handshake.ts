/**
 * How a replacement server waits for the one it replaces. The old process
 * still holds the port and the state file while it shuts down, so the child
 * spawned to succeed it must not bind or write until that pid is gone — a
 * child that starts early either fails on the port or has its fresh state
 * file deleted by the parent's own cleanup.
 */

import { createProcessController, type ProcessController, waitForExit } from './process-control';
import { sleep } from './sleep';

/** Env key carrying the pid a `__serve` child waits on before starting. */
export const RESTART_WAIT_PID_ENV = 'MANGO_RESTART_WAIT_PID';

/** Longer than `stop`'s own budget, so a slow graceful stop still wins. */
export const RESTART_WAIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

export interface PredecessorWaitDeps {
  controller: ProcessController;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Reads the predecessor pid from the environment; null when there is none. */
export function predecessorPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[RESTART_WAIT_PID_ENV];
  if (!raw) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Block until the predecessor exits or the budget runs out; true when it is
 * gone. A timeout is not fatal here — the caller's own port bind reports the
 * collision with a clearer message than this could.
 * // Usage: await waitForPredecessor(pid)
 */
export async function waitForPredecessor(
  pid: number,
  deps: Partial<PredecessorWaitDeps> = {}
): Promise<boolean> {
  const controller = deps.controller ?? createProcessController();
  return await waitForExit(controller, pid, {
    timeoutMs: RESTART_WAIT_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? sleep,
  });
}
