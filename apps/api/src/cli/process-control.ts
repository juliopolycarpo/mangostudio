/**
 * Abstraction over OS process signals so commands stay testable without
 * sending real signals. Cross-platform via Node/Bun's process.kill mapping.
 */
import { readProcessStartMs } from '../lib/process-start-time';
import { readProcessStartToken } from '../lib/process-start-token';
import {
  classifyStateProcess,
  readState,
  removeState,
  type ServerState,
  type StateProcessProbe,
} from '../lib/server-state';
import { SHUTDOWN_BUDGET_MS } from '../server/shutdown-request';
import { CliError } from './errors';
import {
  type HubShutdownRequester,
  requestHubShutdown,
  SHUTDOWN_REQUEST_TIMEOUT_MS,
} from './hub-shutdown-request';

export interface ProcessController extends StateProcessProbe {
  /** True when the pid refers to a live process. */
  isAlive(pid: number): boolean;
  /** When the process started (epoch ms); `undefined` when the platform query failed. */
  startTimeMs(pid: number): Promise<number | undefined>;
  /** The process's start token, comparable for equality; `undefined` when the query failed. */
  startToken(pid: number): Promise<string | undefined>;
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
    startTimeMs: readProcessStartMs,
    startToken: readProcessStartToken,
    terminate: (pid) => signal(pid, 'SIGTERM'),
    kill: (pid) => signal(pid, 'SIGKILL'),
  };
}

/**
 * How long a caller waits for a hub to stand down, and how often it looks.
 * Shared so the budget cannot go out of step between the commands that stop a
 * hub — the unit's own `serve` waits 15s on the state-file holder, so a longer
 * one here would outlast the hand-over it exists for.
 */
export const STOP_TIMEOUT_MS = 10_000;
export const STOP_POLL_INTERVAL_MS = 200;

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

/**
 * How long a hard stop is given. `TerminateProcess` is immediate; this only covers the OS
 * releasing the pid.
 */
export const HARD_STOP_TIMEOUT_MS = 1_000;

/**
 * How long the CLI waits for the pid to exit after the hub accepted a shutdown request. It
 * outlasts the hub's own stop watchdog ({@link SHUTDOWN_BUDGET_MS}) by a margin for the process
 * to exit, so the CLI never ends a hub that is still inside its budget: when a stop does overrun,
 * it is the hub's watchdog that gives up first.
 */
export const HUB_SHUTDOWN_WAIT_MS = SHUTDOWN_BUDGET_MS + 500;

/**
 * The whole of a win32 stop: the request, the wait after it, the hard stop. One deadline taken
 * when `terminateHub` starts, kept under the 15s a successor or a unit's `serve` waits on the
 * predecessor (`RESTART_WAIT_TIMEOUT_MS` in `restart-handshake.ts`, which imports this module, so
 * it is only named here); a test pins both orderings.
 */
export const HUB_STOP_DEADLINE_MS =
  SHUTDOWN_REQUEST_TIMEOUT_MS + HUB_SHUTDOWN_WAIT_MS + HARD_STOP_TIMEOUT_MS;

/** What `terminateHub` needs from its caller's dependency bag. */
export interface HubTerminationDeps {
  readonly controller: ProcessController;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Picks how the hub is stopped and the manual-stop command a refusal names; the real platform when omitted. */
  readonly platform?: NodeJS.Platform;
  /** Asks the hub to shut itself down; the real loopback request when omitted. */
  readonly requestShutdown?: HubShutdownRequester;
  /** Says that the graceful path was not used, and why. Silent when omitted. */
  readonly notice?: (message: string) => void;
  /** The state-file reader and remover for the cleanup after a win32 stop; the real ones when omitted. */
  readonly readState?: typeof readState;
  readonly removeState?: typeof removeState;
}

/** What `stopPidOrThrow` needs from its caller's dependency bag. */
export type StopDeps = HubTerminationDeps;

export interface TerminateHubOptions {
  /** Budget for the pid to exit after a SIGTERM (POSIX). The win32 budgets are fixed above. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * End the hub and wait for its pid to go; true if it did.
 *
 * Where SIGTERM is catchable the signal is the graceful stop and nothing else is tried. On win32
 * `terminate` is `TerminateProcess`, which skips the hub's cleanup (in-flight turns, runtime
 * children, the SQLite WAL checkpoint), so the hub is first asked to stop itself over loopback.
 * If it cannot be asked, declines, or outlives {@link HUB_SHUTDOWN_WAIT_MS}, the hard stop follows
 * with a notice saying so. The request, the wait and the hard stop share one
 * {@link HUB_STOP_DEADLINE_MS} budget: the hard stop always keeps its slice, and the wait takes
 * whatever the request left.
 *
 * A stopped win32 hub that did not get to remove the state file (it was ended hard) is cleared
 * here, only while the file still names this pid: a successor may already have written its own.
 * // Usage: const stopped = await terminateHub(d, state)
 */
export async function terminateHub(
  d: HubTerminationDeps,
  state: ServerState,
  options: TerminateHubOptions = {}
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? STOP_POLL_INTERVAL_MS;
  const wait = (budgetMs: number) =>
    waitForExit(d.controller, state.pid, {
      timeoutMs: Math.max(0, budgetMs),
      intervalMs,
      now: d.now,
      sleep: d.sleep,
    });

  if ((d.platform ?? process.platform) !== 'win32') {
    d.controller.terminate(state.pid);
    return await wait(options.timeoutMs ?? STOP_TIMEOUT_MS);
  }

  const deadline = d.now() + HUB_STOP_DEADLINE_MS;
  const answer = await (d.requestShutdown ?? requestHubShutdown)(state, {
    timeoutMs: SHUTDOWN_REQUEST_TIMEOUT_MS,
  });
  let stopped = false;
  if (answer.accepted) {
    stopped = await wait(deadline - HARD_STOP_TIMEOUT_MS - d.now());
    if (!stopped) {
      d.notice?.(
        `MangoStudio (PID ${state.pid}) did not exit within ${HUB_SHUTDOWN_WAIT_MS / 1000}s of the shutdown request; ending it.`
      );
    }
  } else {
    d.notice?.(
      `Could not ask MangoStudio (PID ${state.pid}) to shut down gracefully: ${answer.reason}. Ending it; in-flight work is not finished.`
    );
  }
  if (!stopped) {
    d.controller.terminate(state.pid);
    stopped = await wait(HARD_STOP_TIMEOUT_MS);
  }
  if (stopped) await removeStateStillNaming(d, state.pid);
  return stopped;
}

/** Remove the state file only when it still names `pid`. // Usage: await removeStateStillNaming(d, 42) */
async function removeStateStillNaming(d: HubTerminationDeps, pid: number): Promise<void> {
  const current = await (d.readState ?? readState)();
  if (current?.pid !== pid) return;
  await (d.removeState ?? removeState)();
}

/**
 * What a person can type to end `pid` themselves, for the refusal below.
 *
 * @example
 * manualStopCommand(4242, 'linux'); // 'kill 4242'
 */
export function manualStopCommand(pid: number, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}

/**
 * Refuse to signal the pid a state file names unless it is the hub. The state file outlives a
 * crashed hub, and the OS may have given its pid to someone's editor or shell, so every signal
 * to a recorded pid passes through here.
 *
 * - a different start token: a recycled pid, never signalled;
 * - identity not provable (older hub without a token, unreadable start time): refuse and name the
 *   command that stops it by hand, and `killserver --force`, rather than kill on a guess.
 *   Deleting the state file is not offered as a way out: the hub may be running.
 * // Usage: await assertSignalsReachHub(controller, state)
 */
export async function assertSignalsReachHub(
  controller: ProcessController,
  state: ServerState,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const kind = await classifyStateProcess(state, controller);
  if (kind === 'hub') return;
  if (kind === 'stale') {
    throw new CliError(
      `PID ${state.pid} is no longer the MangoStudio hub (another process now uses it), so no signal was sent.`
    );
  }
  throw new CliError(
    `Cannot confirm PID ${state.pid} is MangoStudio, so no signal was sent. If it is the hub, stop it with "${manualStopCommand(state.pid, platform)}" or run "mangostudio killserver --force".`
  );
}

/**
 * Terminate the hub a state file names and wait for it to go, raising `message` if it outlives
 * the stop budget. The message is the caller's, since what to do next differs — restart tells
 * the user to serve again, install tells them the unit is already registered and waiting for the
 * port. Throws before signalling when the pid is not provably the hub.
 * // Usage: await stopPidOrThrow(d, state, `PID ${state.pid} did not stop.`)
 */
export async function stopPidOrThrow(
  d: StopDeps,
  state: ServerState,
  message: string
): Promise<void> {
  await assertSignalsReachHub(d.controller, state, d.platform);
  if (!(await terminateHub(d, state))) throw new CliError(message);
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
