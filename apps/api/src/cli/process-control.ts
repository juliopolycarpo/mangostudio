import { getPidFilePath } from '../lib/mango-paths';
/**
 * Abstraction over OS process signals so commands stay testable without
 * sending real signals. Cross-platform via Node/Bun's process.kill mapping.
 */
import { readProcessStartMs } from '../lib/process-start-time';
import {
  classifyStateProcess,
  type ServerState,
  type StateProcessProbe,
} from '../lib/server-state';
import { CliError } from './errors';

export interface ProcessController extends StateProcessProbe {
  /** True when the pid refers to a live process. */
  isAlive(pid: number): boolean;
  /** When the process started (epoch ms); `undefined` when the platform query failed. */
  startTimeMs(pid: number): Promise<number | undefined>;
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

/** What `stopPidOrThrow` needs from its caller's dependency bag. */
export interface StopDeps {
  readonly controller: ProcessController;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Refuse to signal the pid a state file names unless it is the hub. The state file outlives a
 * crashed hub, and the OS may have given its pid to someone's editor or shell, so every signal
 * to a recorded pid passes through here.
 *
 * - alive but started after the state was written: a recycled pid, never signalled;
 * - alive and its start time unreadable: identity cannot be established, so refuse and say how
 *   to proceed rather than kill on a guess.
 * // Usage: await assertSignalsReachHub(controller, state)
 */
export async function assertSignalsReachHub(
  controller: ProcessController,
  state: ServerState
): Promise<void> {
  const kind = await classifyStateProcess(state, controller);
  if (kind === 'hub') return;
  if (kind === 'stale') {
    throw new CliError(
      `PID ${state.pid} is no longer the MangoStudio hub (the process now using it started after the hub did), so no signal was sent. The state file is stale.`
    );
  }
  throw new CliError(
    `Cannot confirm PID ${state.pid} is MangoStudio (its start time could not be read), so no signal was sent. If MangoStudio is not running, delete ${getPidFilePath()}; otherwise stop the process by hand.`
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
  const pid = state.pid;
  await assertSignalsReachHub(d.controller, state);
  d.controller.terminate(pid);
  const stopped = await waitForExit(d.controller, pid, {
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: STOP_POLL_INTERVAL_MS,
    now: d.now,
    sleep: d.sleep,
  });
  if (!stopped) throw new CliError(message);
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
