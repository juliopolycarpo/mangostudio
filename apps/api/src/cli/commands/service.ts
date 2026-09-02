/**
 * `service` command: keep the hub alive across logout and reboot through the
 * platform's per-user supervisor, and drive that unit afterwards.
 */

import type { UserServiceManager } from '@mangostudio/runtime';
import type { UserServiceStatus } from '@mangostudio/shared/runtime-home';
import { ensureRuntimeDirs } from '../../lib/mango-paths';
import { isStateLive, readState, removeState } from '../../lib/server-state';
import {
  buildHubServiceDefinition,
  createHubServiceManager,
  currentHubExecutable,
  hubServiceLogPath,
} from '../../modules/machine/application/hub-service';
import type { HubExecutable } from '../../modules/machine/domain/hub-executable';
import { hubServiceUnitName } from '../../modules/machine/domain/hub-service-identity';
import { assertValidPort, type ServiceArgs } from '../args';
import { ensureServeAuthSecret } from '../auth-secret-setup';
import { CliError } from '../errors';
import { writeLine } from '../output';
import { createProcessController, type ProcessController, waitForExit } from '../process-control';
import { assertServeConfig } from '../serve-config-guard';
import { withServiceErrors } from '../service-errors';
import { sleep } from '../sleep';

export interface ServiceDeps {
  manager: UserServiceManager;
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  ensureAuthSecret: typeof ensureServeAuthSecret;
  assertServeConfig: () => void;
  ensureDirs: () => Promise<void>;
  executable: () => HubExecutable;
  logFile: () => string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

const VERB_MESSAGES: Record<'start' | 'stop' | 'restart', (unit: string) => string> = {
  start: (unit) => `Started the MangoStudio service (${unit}).`,
  stop: (unit) => `Stopped the MangoStudio service (${unit}).`,
  restart: (unit) => `Restart of the MangoStudio service (${unit}) requested.`,
};

/** Install, remove, inspect or drive the hub's service unit. // Usage: await runService({ action: 'install', json: false }) */
export async function runService(
  args: ServiceArgs,
  deps: Partial<ServiceDeps> = {}
): Promise<void> {
  const d = resolveDeps(deps);
  const unit = hubServiceUnitName(d.platform);
  const { action } = args;

  if (action === 'install') {
    await install(args, unit, d);
    return;
  }
  if (action === 'uninstall') {
    await withServiceErrors(() => d.manager.uninstall());
    d.log(`Removed the MangoStudio service (${unit}).`);
    return;
  }
  if (action === 'status') {
    const status = await withServiceErrors(() => d.manager.status());
    printStatus(status, args.json, d);
    return;
  }
  await withServiceErrors(() => d.manager[action]());
  d.log(VERB_MESSAGES[action](unit));
}

async function install(args: ServiceArgs, unit: string, d: Required<ServiceDeps>): Promise<void> {
  if (args.port !== undefined) {
    assertValidPort(args.port);
  }
  // The unit runs without a terminal, so anything that would prompt has to
  // happen now, while there is one.
  await d.ensureAuthSecret({ log: d.log });
  d.assertServeConfig();
  await d.ensureDirs();

  const restartAfter = await yieldRunningInstance(d);
  const executable = d.executable();
  const definition = buildHubServiceDefinition({
    executable,
    unitName: unit,
    logFile: d.logFile(),
    env: d.env,
    target: { host: args.host, port: args.port },
  });

  await withServiceErrors(() => d.manager.install(definition));
  if (restartAfter) {
    await withServiceErrors(() => d.manager.restart());
  }

  d.log(`Installed and started the MangoStudio service (${unit}).`);
  d.log(`  Runs:    ${definition.argv.join(' ')}`);
  d.log(`  Logs:    ${definition.logFile}`);
  if (executable.note) {
    d.log(`  Note:    ${executable.note}`);
  }
}

/**
 * A unit that starts while another instance holds the state file refuses to
 * serve, and the supervisor then restarts it forever. So an instance started
 * by hand is stopped first, and one the service already runs is restarted
 * after the unit is rewritten.
 */
async function yieldRunningInstance(d: Required<ServiceDeps>): Promise<boolean> {
  const state = await d.readState();
  if (!state) return false;
  if (!isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    await d.removeState();
    return false;
  }
  if (state.service) return true;

  d.log(
    `Stopping the instance started outside the service (PID ${state.pid}) so the service can take its place.`
  );
  d.controller.terminate(state.pid);
  const stopped = await waitForExit(d.controller, state.pid, {
    timeoutMs: STOP_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
    now: d.now,
    sleep: d.sleep,
  });
  if (!stopped) {
    throw new CliError(
      `The running instance (PID ${state.pid}) did not stop within 10s; run "mangostudio killserver" and install again.`
    );
  }
  return false;
}

function printStatus(status: UserServiceStatus, json: boolean, d: Required<ServiceDeps>): void {
  if (json) {
    d.log(JSON.stringify(status, null, 2));
    return;
  }
  d.log(`Service:   ${status.unitName} (${status.platform})`);
  d.log(`Installed: ${status.installed}`);
  d.log(`Enabled:   ${status.enabled}`);
  d.log(`Running:   ${status.running}`);
  if (status.linger !== undefined) d.log(`Linger:    ${status.linger}`);
  if (status.execPath) d.log(`Runs:      ${status.execPath}`);
  if (status.manager?.unitPath) d.log(`Unit:      ${status.manager.unitPath}`);
  if (status.error) d.log(`Error:     ${status.error}`);
}

function resolveDeps(deps: Partial<ServiceDeps>): Required<ServiceDeps> {
  return {
    manager: deps.manager ?? createHubServiceManager(),
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    log: deps.log ?? writeLine,
    ensureAuthSecret: deps.ensureAuthSecret ?? ensureServeAuthSecret,
    assertServeConfig: deps.assertServeConfig ?? assertServeConfig,
    ensureDirs: deps.ensureDirs ?? ensureRuntimeDirs,
    executable: deps.executable ?? (() => currentHubExecutable()),
    logFile: deps.logFile ?? hubServiceLogPath,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? sleep,
  };
}
