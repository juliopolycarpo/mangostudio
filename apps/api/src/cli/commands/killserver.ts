/**
 * `killserver` command: force-kill the running server (SIGKILL).
 */

import { type KillServerArgs } from '../args';
import { runServerStopCommand, type ServerShutdownDeps } from '../server-shutdown';

export type KillDeps = ServerShutdownDeps;

const KILL_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

/**
 * Force-kill the running server and clear its state file. Without `--force` the recorded pid must
 * first be shown to be the hub.
 * // Usage: await runKillServer({ force: true })
 */
export async function runKillServer(
  args: KillServerArgs = { force: false },
  deps: Partial<KillDeps> = {}
): Promise<void> {
  await runServerStopCommand({
    deps,
    skipIdentityCheck: args.force,
    signal: 'kill',
    timeoutMs: KILL_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    noInstanceMessage: 'No running instance to kill.',
    successMessage: (pid) => `MangoStudio force-killed (PID ${pid}).`,
    failureMessage: (pid) => `Failed to kill PID ${pid}.`,
    removeStateAfterSignal: true,
  });
}
