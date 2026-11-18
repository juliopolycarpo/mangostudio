/**
 * `stop` command: stop the running server (SIGTERM, wait for exit). On
 * Windows SIGTERM is a hard kill, so the command first asks the hub over
 * loopback to stop itself, and only falls back to the kill when that fails or
 * times out. It also removes the state file a killed hub never got to clean up.
 */

import { runServerStopCommand, type ServerShutdownDeps } from '../server-shutdown';

/** `platform` (host OS) is injected so the Windows path is testable on any CI host. */
export type StopDeps = ServerShutdownDeps;

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/**
 * Stop the running server. Where `terminate` is catchable (POSIX) the hub
 * removes its own state file. On win32 `process.kill` is `TerminateProcess`, so
 * the hub is asked to stop itself first (it then removes the file too); if it is
 * killed instead, this command clears the file once the pid is gone.
 * // Usage: await runStop({ platform: 'win32' })
 */
export async function runStop(deps: Partial<StopDeps> = {}): Promise<void> {
  const { platform = process.platform, ...shutdownDeps } = deps;
  await runServerStopCommand({
    deps: { ...shutdownDeps, platform },
    signal: 'terminate',
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    noInstanceMessage: 'No running instance to stop.',
    successMessage: (pid) => `MangoStudio stopped (PID ${pid}).`,
    failureMessage: () => "MangoStudio did not stop in time; try 'mangostudio killserver'.",
    removeStateWhenStopped: platform === 'win32',
  });
}
