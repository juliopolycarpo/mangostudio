/**
 * `restart` command: bring the server back the way it was started. A service
 * unit is bounced through its supervisor, a detached instance is stopped and
 * respawned, and a foreground instance is left to the terminal that owns it.
 */

import type { UserServiceManager } from '@mangostudio/shared/machine/service';

import {
  classifyStateProcess,
  readState,
  removeState,
  type ServerState,
} from '../../lib/server-state';
import {
  createHubServiceManager,
  currentHubExecutable,
  currentHubExecutableProbe,
  currentLauncherPath,
  restartHubService,
} from '../../modules/machine/application/hub-service';
import type { HubExecutable } from '../../modules/machine/domain/hub-executable';
import { hubLaunchMode, hubUrl } from '../../modules/machine/domain/hub-process';
import { spawnDetached } from '../detach';
import { CliError } from '../errors';
import { confirmsHealthy } from '../health';
import { type HubShutdownRequester, requestHubShutdown } from '../hub-shutdown-request';
import { writeLine } from '../output';
import {
  createProcessController,
  type ProcessController,
  STOP_POLL_INTERVAL_MS,
  stopPidOrThrow,
} from '../process-control';
import { readRestartTargetVersion, restartDetachedHub } from '../restart-detached';
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
  /** Picks the manual-stop command a refusal names (`kill` or `taskkill`). */
  platform: NodeJS.Platform;
  /** Asks the hub to shut itself down where a signal cannot (win32). */
  requestShutdown: HubShutdownRequester;
  /** What a unit (or a respawned detached instance) would run right now. */
  executable: () => HubExecutable;
  /**
   * The package manager's own launcher for this install, when it left a
   * marker — the path a restart has to come back through, since the version
   * directory this process runs from is the manager's to replace.
   */
  launcherPath: () => string | undefined;
  /** Whether a path exists; the launcher a stale unit moves to must be one the manager left. */
  pathExists: (path: string) => boolean;
  /** Runs the launcher with `--version` before the old hub is stopped; throws when it cannot run. */
  readTargetVersion: (argv: readonly string[]) => Promise<string>;
}

const COMEBACK_TIMEOUT_MS = 20_000;

/**
 * Restart the running server, or start the service when nothing runs.
 *
 * On launchd the hub's web restart runs this command from a one-shot helper
 * agent (see `UserServiceManager.startRetargetHelper`). Whatever ran it, the
 * helper is removed last: a plist left in LaunchAgents would run this again at
 * the next login. A failure to remove it is not worth failing the restart for;
 * the next hub start removes it too.
 * // Usage: await runRestart()
 */
export async function runRestart(deps: Partial<RestartDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  try {
    await restartHub(d);
  } finally {
    await d.manager.removeRetargetHelper().catch(() => undefined);
  }
}

async function restartHub(d: Required<RestartDeps>): Promise<void> {
  const state = await d.readState();
  // A recycled pid (token mismatch) reads as no instance, like a dead one; an unconfirmed pid
  // goes on to `stopPidOrThrow`, which refuses it.
  const alive = state !== null && (await classifyStateProcess(state, d.controller)) !== 'stale';

  if (!state || !alive) {
    if (state) await d.removeState();
    await startInstalledService(d);
    return;
  }

  const mode = hubLaunchMode(state);
  if (mode === 'service') {
    await bringUpUnit(d, { start: false });
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
  await bringUpUnit(d, { start: true });
  const next = await waitForComeback(null, d);
  d.log(
    `MangoStudio started through ${status.unitName} (PID ${next.pid}, ${hubUrl(next.host, next.port)}).`
  );
}

/**
 * A unit installed before it named the manager's launcher records a versioned
 * path that an upgrade replaced; the supervisor moves it onto the launcher as
 * part of the start or bounce, or the restart runs the old build (or none at
 * all).
 */
async function bringUpUnit(d: Required<RestartDeps>, options: { start: boolean }): Promise<void> {
  const moved = await restartHubService(d.manager, d.launcherPath(), {
    ...options,
    probe: { platform: d.platform, pathExists: d.pathExists },
    warn: d.log,
  });
  if (moved) d.log(`Updated the service unit to run ${moved.to} (it named ${moved.from}).`);
}

/**
 * Stop, then spawn a successor that waits for this pid before binding. The
 * successor is spawned only after the stop is confirmed, so its wait is a
 * safety net rather than the mechanism.
 */
async function restartDetached(state: ServerState, d: Required<RestartDeps>): Promise<void> {
  const result = await restartDetachedHub(
    { state, executable: d.executable(), launcherPath: d.launcherPath() },
    {
      stop: () =>
        stopPidOrThrow(
          { ...d, notice: d.log },
          state,
          `MangoStudio (PID ${state.pid}) did not stop within 10s; try "mangostudio killserver" and then "mangostudio serve -d".`
        ),
      spawnDetached: d.spawnDetached,
      readTargetVersion: d.readTargetVersion,
    }
  );
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
    await d.sleep(STOP_POLL_INTERVAL_MS);
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
    platform: deps.platform ?? process.platform,
    requestShutdown: deps.requestShutdown ?? requestHubShutdown,
    executable: deps.executable ?? (() => currentHubExecutable()),
    launcherPath: deps.launcherPath ?? currentLauncherPath,
    pathExists: deps.pathExists ?? currentHubExecutableProbe().pathExists,
    readTargetVersion: deps.readTargetVersion ?? readRestartTargetVersion,
  };
}
