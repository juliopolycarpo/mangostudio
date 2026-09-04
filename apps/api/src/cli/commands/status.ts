/**
 * `status` command: report whether a server is running and its details, as
 * text or as the shared hub status document with `--json`.
 */

import type { HubHealth } from '@mangostudio/shared/machine';
import type { UpdateCheck } from '@mangostudio/shared/updates';
import { formatBuildInfo, formatBuildSha } from '../../lib/build-info';
import { getConfig, getVersion } from '../../lib/config';
import { isStateLive, readState, removeState, type ServerState } from '../../lib/server-state';
import { currentInstallOriginProbe } from '../../modules/machine/application/hub-service';
import { describeHubProcess } from '../../modules/machine/domain/hub-process';
import {
  type InstallStatus,
  resolveInstallStatus,
} from '../../modules/updates/application/install-status';
import { updateChecker } from '../../modules/updates/application/update-check';
import { describeInstallManager } from '../../modules/updates/domain/install-origin';
import type { StatusArgs } from '../args';
import { formatUptime } from '../format';
import { canProbeHealth, probeHealth, probeHubHealth } from '../health';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';

export interface StatusDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  probeHealth: typeof probeHealth;
  canProbeHealth: typeof canProbeHealth;
  log: (msg: string) => void;
  now: () => number;
  /** Never hits the network: install origin plus the effective channel and upgrade command. */
  installStatus: () => InstallStatus;
  /** Whatever the release checker last wrote to disk; never a network call. */
  readCachedUpdate: () => UpdateCheck | null;
}

const DEFAULT_ARGS: StatusArgs = { json: false };

/** Print whether a server is running and its details. // Usage: await runStatus({ json: true }) */
export async function runStatus(
  args: StatusArgs = DEFAULT_ARGS,
  deps: Partial<StatusDeps> = {}
): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();
  const alive = state !== null && isStateLive(state, (pid) => d.controller.isAlive(pid));

  if (!state || !alive) {
    if (state) {
      await d.removeState();
    }
    if (args.json) {
      // Same shape and same formatting as the running answer: a reader that
      // pipes this into a diff or an editor should not have to handle two.
      d.log(
        JSON.stringify(describeHubProcess({ state: null, alive: false, now: d.now() }), null, 2)
      );
      return;
    }
    d.log('MangoStudio is not running.');
    return;
  }

  const health = await probeHubHealth(state.host, state.port, d);
  if (args.json) {
    d.log(
      JSON.stringify(describeHubProcess({ state, alive: true, now: d.now(), health }), null, 2)
    );
    return;
  }
  printRunning(state, health, d);
}

function printRunning(state: ServerState, health: HubHealth, d: Required<StatusDeps>): void {
  const status = describeHubProcess({ state, alive: true, now: d.now(), health });
  d.log('MangoStudio is running.');
  d.log(`  PID:     ${state.pid}`);
  d.log(`  Port:    ${state.port}`);
  d.log(`  Host:    ${state.host}`);
  d.log(`  URL:     ${status.url}`);
  d.log(`  Uptime:  ${formatUptime(status.uptimeMs ?? 0)}`);
  d.log(`  Launch:  ${status.launch}${state.service ? ` (${state.service})` : ''}`);
  d.log(`  Logs:    ${state.logFile || '(foreground)'}`);
  d.log(`  Health:  ${health}`);
  d.log(`  Version: ${state.version} (${formatBuildSha(state.buildInfo)})`);
  d.log(`  Build:   ${formatBuildInfo(state.buildInfo)}`);

  const install = d.installStatus();
  d.log(
    `  Installed via: ${describeInstallManager(install.installedVia.manager)} · channel: ${install.channel}`
  );
  const check = d.readCachedUpdate();
  if (check?.updateAvailable) {
    d.log(
      `  Update:  ${check.latestVersion ?? 'a newer build'} available — run: ${install.command}`
    );
  }
}

function resolveDeps(deps: Partial<StatusDeps>): Required<StatusDeps> {
  return {
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    probeHealth: deps.probeHealth ?? probeHealth,
    canProbeHealth: deps.canProbeHealth ?? canProbeHealth,
    log: deps.log ?? writeLine,
    now: deps.now ?? Date.now,
    installStatus:
      deps.installStatus ??
      (() =>
        resolveInstallStatus(
          currentInstallOriginProbe(),
          getConfig().updates.channel,
          getVersion()
        )),
    readCachedUpdate: deps.readCachedUpdate ?? (() => updateChecker.readCached()),
  };
}
