import { classifyStateProcess, readState, removeState } from '../lib/server-state';
import { CliError } from './errors';
import { type HubShutdownRequester, requestHubShutdown } from './hub-shutdown-request';
import { writeError, writeLine } from './output';
import {
  assertSignalsReachHub,
  createProcessController,
  type ProcessController,
  terminateHub,
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
  /** Picks how the hub is stopped and the manual-stop command a refusal names (`kill` or `taskkill`). */
  platform: NodeJS.Platform;
  /** Asks the hub to shut itself down where a signal cannot (win32). */
  requestShutdown: HubShutdownRequester;
}

interface RunServerStopCommandOptions {
  deps?: Partial<ServerShutdownDeps>;
  signal: 'terminate' | 'kill';
  timeoutMs: number;
  intervalMs: number;
  noInstanceMessage: string;
  successMessage: (pid: number) => string;
  failureMessage: (pid: number) => string;
  /**
   * Remove the state file once the signal is sent, whether or not the pid went. For `kill`,
   * which the hub never gets to answer. (`terminate` on win32 clears a stopped hub's file inside
   * `terminateHub`, since a hub ended hard never removed it.)
   */
  removeStateAfterSignal?: boolean;
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
    requestShutdown: deps.requestShutdown ?? requestHubShutdown,
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
  let stopped: boolean;
  if (signal === 'terminate') {
    // On Windows this asks the hub to stop itself first, so its graceful path runs.
    stopped = await terminateHub({ ...d, notice: d.log }, state, { timeoutMs, intervalMs });
    // A win32 hub that was ended hard never removed its file; `terminateHub` already cleared it.
  } else {
    d.controller.kill(state.pid);
    stopped = await waitForExit(d.controller, state.pid, {
      timeoutMs,
      intervalMs,
      now: d.now,
      sleep: d.sleep,
    });
  }

  if (removeStateAfterSignal) await d.removeState();

  if (stopped) {
    d.log(successMessage(state.pid));
    return;
  }

  d.error(failureMessage(state.pid));
  d.exit(1);
}
