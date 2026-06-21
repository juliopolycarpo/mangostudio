/**
 * `stop` command: gracefully stop the running server (SIGTERM, wait for exit).
 */

import { runServerStopCommand, type ServerShutdownDeps } from '../server-shutdown';

export type StopDeps = ServerShutdownDeps;

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/** Gracefully stop the running server. // Usage: await runStop() */
export async function runStop(deps: Partial<StopDeps> = {}): Promise<void> {
  await runServerStopCommand({
    deps,
    signal: 'terminate',
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    noInstanceMessage: 'No running instance to stop.',
    successMessage: (pid) => `MangoStudio stopped (PID ${pid}).`,
    failureMessage: () => "MangoStudio did not stop within 10s; try 'mangostudio killserver'.",
  });
}
