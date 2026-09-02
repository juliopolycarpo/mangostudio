/**
 * `service` command: keep the hub alive across logout and reboot through the
 * platform's per-user supervisor, and drive that unit afterwards.
 */

import type { UserServiceManager } from '@mangostudio/runtime';
import type { UserServiceStatus } from '@mangostudio/shared/runtime-home';
import { getConfig, getConfigEnvFilePath } from '../../lib/config';
import { ensureRuntimeDirs } from '../../lib/mango-paths';
import { isStateLive, readState, removeState, type ServerState } from '../../lib/server-state';
import {
  buildHubServiceDefinition,
  createHubServiceManager,
  currentHubExecutable,
  type HubServiceTarget,
  hubServiceLogPath,
  isAuthSecretPersisted,
} from '../../modules/machine/application/hub-service';
import type { HubExecutable } from '../../modules/machine/domain/hub-executable';
import { hubServiceUnitName } from '../../modules/machine/domain/hub-service-identity';
import { assertValidPort, type ServiceArgs } from '../args';
import { ensureServeAuthSecret } from '../auth-secret-setup';
import { CliError } from '../errors';
import { writeLine } from '../output';
import { createProcessController, type ProcessController, waitForExit } from '../process-control';
import { assertServeConfig } from '../serve-config-guard';
import { sleep } from '../sleep';

export interface ServiceDeps {
  manager: UserServiceManager;
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  ensureAuthSecret: typeof ensureServeAuthSecret;
  /** Whether the auth secret lives where a unit can load it, not just in this shell. */
  secretPersisted: () => boolean;
  envFilePath: () => string;
  /** Where `config.toml` and this shell's environment would bind on their own. */
  configuredTarget: () => { host: string; port: number };
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
    await d.manager.uninstall();
    d.log(`Removed the MangoStudio service (${unit}).`);
    return;
  }
  if (action === 'status') {
    const status = await d.manager.status();
    printStatus(status, args.json, d);
    return;
  }
  await d.manager[action]();
  d.log(VERB_MESSAGES[action](unit));
}

async function install(args: ServiceArgs, unit: string, d: Required<ServiceDeps>): Promise<void> {
  if (args.port !== undefined) {
    assertValidPort(args.port);
  }
  // The unit runs without a terminal, so anything that would prompt has to
  // happen now, while there is one.
  await d.ensureAuthSecret({ log: d.log });
  // A secret that is merely *valid* satisfies the setup above without being
  // written anywhere. Exported in this shell alone it is invisible to the unit,
  // which deliberately carries no secrets — the supervisor would report a
  // successful install and the hub it starts would refuse to serve, after this
  // command had already stood the working one down.
  if (!d.secretPersisted()) {
    throw new CliError(
      `BETTER_AUTH_SECRET is set in this shell only, and a service unit cannot read it. Put it in ${d.envFilePath()} or set auth.secret in config.toml, then install again.`
    );
  }
  d.assertServeConfig();
  await d.ensureDirs();

  const predecessor = await liveInstance(d);
  const executable = d.executable();
  const target = resolveInstallTarget(args, predecessor, d);
  const definition = buildHubServiceDefinition({
    executable,
    unitName: unit,
    logFile: d.logFile(),
    env: d.env,
    platform: d.platform,
    ...(target ? { target } : {}),
  });

  // Register before touching what is serving. Installing can fail for reasons
  // that have nothing to do with the running hub — no session bus, a launchctl
  // refusal, a task command over the Windows limit — and stopping it first
  // would leave the user with neither a server nor a service.
  await d.manager.install(definition);

  // The unit has started, and its `serve` waits on whatever still holds the
  // state file rather than refusing, so the hand-over happens now.
  if (predecessor?.service) {
    await d.manager.restart();
  } else if (predecessor) {
    await stopPredecessor(d, predecessor, unit);
  }

  d.log(`Installed and started the MangoStudio service (${unit}).`);
  d.log(`  Runs:    ${definition.argv.join(' ')}`);
  d.log(`  Logs:    ${definition.logFile}`);
  if (executable.note) {
    d.log(`  Note:    ${executable.note}`);
  }
}

/**
 * What the unit binds to. An explicit flag wins. Otherwise the unit inherits
 * `config.toml`, so a later edit there still moves it — except when the instance
 * it is about to replace is listening somewhere else, which is what `serve -d
 * lan:4000` leaves behind: the hand-over below stops that instance, and a unit
 * on the default port would take neither its address nor its port with it.
 * // Usage: resolveInstallTarget(args, predecessor, d)
 */
function resolveInstallTarget(
  args: ServiceArgs,
  predecessor: ServerState | null,
  d: Required<ServiceDeps>
): HubServiceTarget | undefined {
  if (args.host !== undefined || args.port !== undefined) {
    return {
      ...(args.host === undefined ? {} : { host: args.host }),
      ...(args.port === undefined ? {} : { port: args.port }),
    };
  }
  if (!predecessor) return undefined;
  const configured = d.configuredTarget();
  if (predecessor.host === configured.host && predecessor.port === configured.port) {
    return undefined;
  }
  return { host: predecessor.host, port: predecessor.port };
}

/** The instance still serving, or null. A stale state file is cleared. */
async function liveInstance(d: Required<ServiceDeps>): Promise<ServerState | null> {
  const state = await d.readState();
  if (!state) return null;
  if (isStateLive(state, (pid) => d.controller.isAlive(pid))) return state;
  await d.removeState();
  return null;
}

/**
 * Hand the port from an instance started outside the service to the unit that
 * has just been installed. A unit whose `serve` finds another instance holding
 * the state file waits for it, so it takes over as soon as this pid is gone —
 * and if it never goes, the unit is restarted on a loop, which is what the
 * refusal below is about.
 */
async function stopPredecessor(
  d: Required<ServiceDeps>,
  state: ServerState,
  unit: string
): Promise<void> {
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
      `The service (${unit}) is installed, but the instance started outside it (PID ${state.pid}) did not stop within 10s. Run "mangostudio killserver"; the service takes the port once that pid is gone.`
    );
  }
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
    secretPersisted: deps.secretPersisted ?? (() => isAuthSecretPersisted()),
    envFilePath: deps.envFilePath ?? (() => getConfigEnvFilePath(getConfig().configFilePath)),
    configuredTarget:
      deps.configuredTarget ??
      (() => ({ host: getConfig().server.host, port: getConfig().server.port })),
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
