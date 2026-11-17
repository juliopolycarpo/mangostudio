import { classifyStateProcess, readState, removeState } from '../lib/server-state';
import { CliError } from './errors';
import { writeError, writeLine } from './output';
import {
  assertSignalsReachHub,
  createProcessController,
  type ProcessController,
  waitForExit,
} from './process-control';
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
  /** Picks the manual-stop command a refusal names (`kill` or `taskkill`). */
  platform: NodeJS.Platform;
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
  /**
   * Remove the state file once the pid is confirmed gone. For a signal the hub
   * cannot catch, so its own cleanup never ran; a pid that outlives the wait
   * keeps its file, since that file is the only way left to find it. The file
   * is removed only while it still names the stopped pid: a supervisor restart
   * or a `serve` right after may already have written a successor's.
   */
  removeStateWhenStopped?: boolean;
  /**
   * `killserver --force`: trust the state file's pid without comparing start tokens. A dead pid
   * is still "no instance", and a pid at or below 1 is still refused.
   */
  skipIdentityCheck?: boolean;
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
    platform: deps.platform ?? process.platform,
  };
}

/** Remove the state file only when it still names `pid`. // Usage: await removeStateStillNaming(d, 42) */
async function removeStateStillNaming(d: Required<ServerShutdownDeps>, pid: number): Promise<void> {
  const current = await d.readState();
  if (current?.pid !== pid) return;
  await d.removeState();
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
  removeStateWhenStopped = false,
  skipIdentityCheck = false,
}: RunServerStopCommandOptions): Promise<void> {
  const d = resolveServerShutdownDeps(deps);
  const state = await d.readState();

  const dead = state !== null && !d.controller.isAlive(state.pid);
  const stale =
    state !== null &&
    !skipIdentityCheck &&
    (await classifyStateProcess(state, d.controller)) === 'stale';
  if (!state || dead || stale) {
    if (state) {
      await d.removeState();
    }
    d.log(noInstanceMessage);
    return;
  }

  // Alive, but is it the hub? An unconfirmed pid throws here, before any signal.
  if (skipIdentityCheck) {
    if (!Number.isSafeInteger(state.pid) || state.pid < 2) {
      throw new CliError(`Refusing to signal PID ${state.pid}: expected a PID above 1.`);
    }
  } else await assertSignalsReachHub(d.controller, state, d.platform);
  d.controller[signal](state.pid);
  const stopped = await waitForExit(d.controller, state.pid, {
    timeoutMs,
    intervalMs,
    now: d.now,
    sleep: d.sleep,
  });

  if (removeStateAfterSignal) {
    await d.removeState();
  } else if (removeStateWhenStopped && stopped) {
    await removeStateStillNaming(d, state.pid);
  }

  if (stopped) {
    d.log(successMessage(state.pid));
    return;
  }

  d.error(failureMessage(state.pid));
  d.exit(1);
}
