/**
 * `killserver` command: force-kill the running server (SIGKILL).
 */

import { isStateLive, readState, removeState } from '../../lib/server-state';
import { writeError, writeLine } from '../output';
import { createProcessController, type ProcessController, waitForExit } from '../process-control';

export interface KillDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const KILL_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

/** Force-kill the running server and clear its state file. // Usage: await runKillServer() */
export async function runKillServer(deps: Partial<KillDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();

  if (!state || !isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    if (state) {
      await d.removeState();
    }
    d.log('No running instance to kill.');
    return;
  }

  d.controller.kill(state.pid);
  const dead = await waitForExit(d.controller, state.pid, {
    timeoutMs: KILL_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    now: d.now,
    sleep: d.sleep,
  });

  // A killed process cannot clean up after itself, so remove its state file here.
  await d.removeState();

  if (dead) {
    d.log(`MangoStudio force-killed (PID ${state.pid}).`);
    return;
  }
  d.error(`Failed to kill PID ${state.pid}.`);
  d.exit(1);
}

function resolveDeps(deps: Partial<KillDeps>): Required<KillDeps> {
  return {
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    log: deps.log ?? writeLine,
    error: deps.error ?? writeError,
    exit: deps.exit ?? ((code) => process.exit(code)),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}
