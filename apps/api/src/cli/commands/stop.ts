/**
 * `stop` command: gracefully stop the running server (SIGTERM, wait for exit).
 */

import { isStateLive, readState, removeState } from '../../lib/server-state';
import { writeError, writeLine } from '../output';
import { createProcessController, type ProcessController, waitForExit } from '../process-control';
import { sleep } from '../sleep';

export interface StopDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/** Gracefully stop the running server. // Usage: await runStop() */
export async function runStop(deps: Partial<StopDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();

  if (!state || !isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    if (state) {
      await d.removeState();
    }
    d.log('No running instance to stop.');
    return;
  }

  d.controller.terminate(state.pid);
  const stopped = await waitForExit(d.controller, state.pid, {
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    now: d.now,
    sleep: d.sleep,
  });

  if (stopped) {
    d.log(`MangoStudio stopped (PID ${state.pid}).`);
    return;
  }
  d.error("MangoStudio did not stop within 10s; try 'mangostudio killserver'.");
  d.exit(1);
}

function resolveDeps(deps: Partial<StopDeps>): Required<StopDeps> {
  return {
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    log: deps.log ?? writeLine,
    error: deps.error ?? writeError,
    exit: deps.exit ?? ((code) => process.exit(code)),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? sleep,
  };
}
