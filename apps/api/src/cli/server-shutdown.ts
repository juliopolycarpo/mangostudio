import { isStateLive, readState, removeState } from '../lib/server-state';
import { writeError, writeLine } from './output';
import { createProcessController, type ProcessController, waitForExit } from './process-control';
import { sleep } from './sleep';

export interface ServerShutdownDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface RunServerStopCommandOptions {
  deps?: Partial<ServerShutdownDeps>;
  signal: 'terminate' | 'kill';
  timeoutMs: number;
  intervalMs: number;
  noInstanceMessage: string;
  successMessage: (pid: number) => string;
  failureMessage: (pid: number) => string;
  removeStateAfterSignal?: boolean;
}

function resolveServerShutdownDeps(
  deps: Partial<ServerShutdownDeps> = {}
): Required<ServerShutdownDeps> {
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

export async function runServerStopCommand({
  deps,
  signal,
  timeoutMs,
  intervalMs,
  noInstanceMessage,
  successMessage,
  failureMessage,
  removeStateAfterSignal = false,
}: RunServerStopCommandOptions): Promise<void> {
  const d = resolveServerShutdownDeps(deps);
  const state = await d.readState();

  if (!state || !isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    if (state) {
      await d.removeState();
    }
    d.log(noInstanceMessage);
    return;
  }

  d.controller[signal](state.pid);
  const stopped = await waitForExit(d.controller, state.pid, {
    timeoutMs,
    intervalMs,
    now: d.now,
    sleep: d.sleep,
  });

  if (removeStateAfterSignal) {
    await d.removeState();
  }

  if (stopped) {
    d.log(successMessage(state.pid));
    return;
  }

  d.error(failureMessage(state.pid));
  d.exit(1);
}
