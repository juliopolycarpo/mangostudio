/**
 * `killserver` command: force-kill the running server (SIGKILL).
 */

import { runServerStopCommand, type ServerShutdownDeps } from '../server-shutdown';

export type KillDeps = ServerShutdownDeps;

const KILL_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

/** Force-kill the running server and clear its state file. // Usage: await runKillServer() */
export async function runKillServer(deps: Partial<KillDeps> = {}): Promise<void> {
  await runServerStopCommand({
    deps,
    signal: 'kill',
    timeoutMs: KILL_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    noInstanceMessage: 'No running instance to kill.',
    successMessage: (pid) => `MangoStudio force-killed (PID ${pid}).`,
    failureMessage: (pid) => `Failed to kill PID ${pid}.`,
    removeStateAfterSignal: true,
  });
}
