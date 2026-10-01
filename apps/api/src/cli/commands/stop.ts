/**
 * `stop` command: stop the running server (SIGTERM, wait for exit). On
 * Windows SIGTERM is a hard kill, so the command also removes the state file
 * the hub never got to clean up.
 */

import { runServerStopCommand, type ServerShutdownDeps } from '../server-shutdown';

export interface StopDeps extends ServerShutdownDeps {
  /** Host OS; injected so the Windows path is testable on any CI host. */
  platform: NodeJS.Platform;
}

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/**
 * Stop the running server. Where `terminate` is catchable (POSIX) the hub
 * removes its own state file; on win32 `process.kill` is `TerminateProcess`, so
 * the hub's graceful stop never runs and this command clears the file once the
 * pid is gone.
 * // Usage: await runStop({ platform: 'win32' })
 */
export async function runStop(deps: Partial<StopDeps> = {}): Promise<void> {
  const { platform = process.platform, ...shutdownDeps } = deps;
  await runServerStopCommand({
    deps: shutdownDeps,
    signal: 'terminate',
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    noInstanceMessage: 'No running instance to stop.',
    successMessage: (pid) => `MangoStudio stopped (PID ${pid}).`,
    failureMessage: () => "MangoStudio did not stop within 10s; try 'mangostudio killserver'.",
    removeStateWhenStopped: platform === 'win32',
  });
}
