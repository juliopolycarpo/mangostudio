/**
 * `status` command: report whether a server is running and its details.
 */

import { formatBuildInfo, formatBuildSha } from '../../lib/build-info';
import { isStateLive, readState, removeState, type ServerState } from '../../lib/server-state';
import { formatUptime } from '../format';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';

export interface StatusDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  now: () => number;
}

/** Print whether a server is running and its details. // Usage: await runStatus() */
export async function runStatus(deps: Partial<StatusDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();

  if (!state || !isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    if (state) {
      await d.removeState();
    }
    d.log('MangoStudio is not running.');
    return;
  }

  printRunning(state, d);
}

function printRunning(state: ServerState, d: Required<StatusDeps>): void {
  d.log('MangoStudio is running.');
  d.log(`  PID:     ${state.pid}`);
  d.log(`  Port:    ${state.port}`);
  d.log(`  Host:    ${state.host}`);
  d.log(`  Uptime:  ${formatUptime(d.now() - state.startedAt)}`);
  d.log(`  Logs:    ${state.logFile || '(foreground)'}`);
  d.log('  Health:  not probed');
  d.log(`  Version: ${state.version} (${formatBuildSha(state.buildInfo)})`);
  d.log(`  Build:   ${formatBuildInfo(state.buildInfo)}`);
}

function resolveDeps(deps: Partial<StatusDeps>): Required<StatusDeps> {
  return {
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    log: deps.log ?? writeLine,
    now: deps.now ?? Date.now,
  };
}
