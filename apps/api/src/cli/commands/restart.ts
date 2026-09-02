/**
 * `restart` command: bring the server back the way it was started. A service
 * unit is bounced through its supervisor, a detached instance is stopped and
 * respawned, and a foreground instance is left to the terminal that owns it.
 */

import type { UserServiceManager } from '@mangostudio/runtime';
import { isStateLive, readState, removeState, type ServerState } from '../../lib/server-state';
import { createHubServiceManager } from '../../modules/machine/application/hub-service';
import { hubLaunchMode, hubUrl } from '../../modules/machine/domain/hub-process';
import { spawnDetached } from '../detach';
import { CliError } from '../errors';
import { confirmsHealthy } from '../health';
import { writeLine } from '../output';
import { createProcessController, type ProcessController, waitForExit } from '../process-control';
import { sleep } from '../sleep';

export interface RestartDeps {
  manager: UserServiceManager;
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  spawnDetached: typeof spawnDetached;
  confirmsHealthy: typeof confirmsHealthy;
  log: (msg: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const STOP_TIMEOUT_MS = 10_000;
const COMEBACK_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;

/** Restart the running server, or start the service when nothing runs. // Usage: await runRestart() */
export async function runRestart(deps: Partial<RestartDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();
  const alive = state !== null && isStateLive(state, (pid) => d.controller.isAlive(pid));

  if (!state || !alive) {
    if (state) await d.removeState();
    await startInstalledService(d);
    return;
  }

  const mode = hubLaunchMode(state);
  if (mode === 'service') {
    await d.manager.restart();
    d.log(`Restart requested through ${state.service}.`);
    const next = await waitForComeback(state.pid, d);
    d.log(`MangoStudio restarted (PID ${next.pid}, ${hubUrl(next.host, next.port)}).`);
    return;
  }
  if (mode === 'detached') {
    await restartDetached(state, d);
    return;
  }
  throw new CliError(
    `MangoStudio was started in the foreground (PID ${state.pid}). Press Ctrl-C in its terminal and run "mangostudio serve" again.`
  );
}

async function startInstalledService(d: Required<RestartDeps>): Promise<void> {
  const status = await d.manager.status();
  if (!status.installed) {
    throw new CliError(
      'No running instance to restart. Start one with "mangostudio serve -d", or install the service with "mangostudio service install".'
    );
  }
  await d.manager.start();
  const next = await waitForComeback(null, d);
  d.log(
    `MangoStudio started through ${status.unitName} (PID ${next.pid}, ${hubUrl(next.host, next.port)}).`
  );
}

/**
 * Stop, then spawn a successor that waits for this pid before binding. The
 * successor is spawned only after the stop is confirmed, so its wait is a
 * safety net rather than the mechanism.
 */
async function restartDetached(state: ServerState, d: Required<RestartDeps>): Promise<void> {
  d.controller.terminate(state.pid);
  const stopped = await waitForExit(d.controller, state.pid, {
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    now: d.now,
    sleep: d.sleep,
  });
  if (!stopped) {
    throw new CliError(
      `MangoStudio (PID ${state.pid}) did not stop within 10s; try "mangostudio killserver" and then "mangostudio serve -d".`
    );
  }
  const result = await d.spawnDetached(state.port, state.host, {}, { waitForPid: state.pid });
  d.log(`MangoStudio restarted (PID ${result.pid}, ${hubUrl(state.host, result.port)}).`);
  d.log(`Logs: ${result.logFile}`);
}

/**
 * Poll the state file until a different, healthy pid owns it. "Healthy" is the
 * health endpoint where it can be reached; for a hub bound to one explicit LAN
 * address it is a live pid owning the state file, since the probe only ever
 * fetches loopback and would otherwise burn the whole budget on a successor
 * that came back fine.
 */
async function waitForComeback(
  previousPid: number | null,
  d: Required<RestartDeps>
): Promise<ServerState> {
  const deadline = d.now() + COMEBACK_TIMEOUT_MS;
  while (d.now() < deadline) {
    const state = await d.readState();
    if (
      state &&
      state.pid !== previousPid &&
      d.controller.isAlive(state.pid) &&
      (await d.confirmsHealthy(state.host, state.port))
    ) {
      return state;
    }
    await d.sleep(POLL_INTERVAL_MS);
  }
  throw new CliError(
    `The service did not come back within ${COMEBACK_TIMEOUT_MS / 1000}s. Check "mangostudio logs" and "mangostudio service status".`
  );
}

function resolveDeps(deps: Partial<RestartDeps>): Required<RestartDeps> {
  return {
    manager: deps.manager ?? createHubServiceManager(),
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    spawnDetached: deps.spawnDetached ?? spawnDetached,
    confirmsHealthy: deps.confirmsHealthy ?? confirmsHealthy,
    log: deps.log ?? writeLine,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? sleep,
  };
}
