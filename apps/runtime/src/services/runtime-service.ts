/**
 * User-level service install for `connect` and `serve` on the `remote` slot.
 *
 * The supervisor work lives in `user-service-manager.ts`; this module is the
 * slot policy over it: preconditions (setup done, mode configured, a binary
 * reachable through `current`), mode inference, and the doctor view.
 */

import {
  RUNTIME_BINARY_BASENAME,
  type RuntimeServiceMode,
  type RuntimeServiceStatus,
  type RuntimeSlot,
  runtimeSlotCurrentBinaryPath,
  runtimeSlotCurrentDir,
} from '@mangostudio/shared/runtime-home';
import { loadRuntimeConfig } from '../config';
import { RuntimeServiceManagementError } from '../errors';
import {
  type RuntimeSlotState,
  readPairingToken,
  readRuntimeSlotState,
  readServeToken,
} from '../runtime-home';
import {
  createUserServiceManager,
  defaultUserServiceExecDeps,
  USER_SERVICE_NO_SESSION_BUS_ERROR,
  type UserServiceExecDeps,
  type UserServiceExecResult,
  type UserServiceIdentity,
} from './user-service-manager';

export const RUNTIME_SERVICE_DOCS_URL =
  'https://github.com/juliopolycarpo/mangostudio/blob/main/docs/operations/remote-runtimes.md';

const RUNTIME_CLI_NAME = 'mangostudio-runtime';
const SYSTEMD_UNIT_BASENAME = 'mangostudio-runtime.service';
const LAUNCHD_LABEL = 'com.mangostudio.runtime';
const TASK_NAME = 'MangoStudio runtime';

/** The runtime's unit under each supervisor. Exported for the unit tests. */
export const RUNTIME_SERVICE_IDENTITY: UserServiceIdentity = {
  unitName: SYSTEMD_UNIT_BASENAME,
  launchdLabel: LAUNCHD_LABEL,
  taskName: TASK_NAME,
  cliName: RUNTIME_CLI_NAME,
  docsUrl: RUNTIME_SERVICE_DOCS_URL,
};

/**
 * Exported because doctor branches on this one specifically: it is the single
 * `status.error` that means "could not look", not "nothing is there".
 */
export const RUNTIME_SERVICE_NO_SESSION_BUS_ERROR = USER_SERVICE_NO_SESSION_BUS_ERROR;

export type RuntimeServiceExecResult = UserServiceExecResult;
export type RuntimeServiceExecDeps = UserServiceExecDeps;

const PAIRED_SLOT = 'remote' as const satisfies RuntimeSlot;

function homeOptions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  return { mangoHome: loadRuntimeConfig(env).mangoHome, platform };
}

/** What the runtime's unit runs in each mode. // Usage: runtimeUnitDefinition(bin, 'connect') */
export function runtimeUnitDefinition(binaryPath: string, mode: RuntimeServiceMode) {
  return { description: `MangoStudio runtime (${mode})`, argv: [binaryPath, mode] };
}

/**
 * Accepts the `current` directory or the binary inside it. A bare
 * `current/` substring is deliberately not enough: it matches any slot on any
 * home, which would call a unit pointing at someone else's install correct.
 */
export function execStartUsesCurrent(unitBody: string, currentBinaryPath: string): boolean {
  const normalized = currentBinaryPath.replaceAll('\\', '/');
  const alt = normalized.endsWith(`/${RUNTIME_BINARY_BASENAME}`)
    ? normalized
    : `${normalized}/${RUNTIME_BINARY_BASENAME}`;
  return unitBody.includes(normalized) || unitBody.includes(alt);
}

export async function assertServicePreconditions(
  mode: RuntimeServiceMode,
  slotState: RuntimeSlotState,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const { config, error } = slotState;
  if (error) {
    throw new RuntimeServiceManagementError(
      'runtime_service_setup_pending',
      `${error} Run "mangostudio-runtime setup --slot ${PAIRED_SLOT}" before installing a service.`
    );
  }
  if (config.setup.state === 'pending') {
    throw new RuntimeServiceManagementError(
      'runtime_service_setup_pending',
      `Runtime setup is pending on this machine. Run "mangostudio-runtime setup --slot ${PAIRED_SLOT}" first.`
    );
  }
  if (mode === 'connect') {
    if (!config.hubUrl) {
      throw new RuntimeServiceManagementError(
        'runtime_service_unconfigured',
        'Connect is not configured. Run "mangostudio-runtime connect --hub <url>" once before "service install --mode connect".'
      );
    }
    const token = await readPairingToken(PAIRED_SLOT, env);
    if (!token) {
      throw new RuntimeServiceManagementError(
        'runtime_service_unconfigured',
        'No pairing token is stored. Run "mangostudio-runtime connect" with a token before installing the connect service.'
      );
    }
    return;
  }
  if (!config.serveListen) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unconfigured',
      'Serve is not configured. Run "mangostudio-runtime serve --listen <host:port>" once before "service install --mode serve".'
    );
  }
  const serveToken = await readServeToken(PAIRED_SLOT, env);
  if (!serveToken) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unconfigured',
      'No serve token is stored. Run "mangostudio-runtime serve" once before installing the serve service.'
    );
  }
}

export function resolveInstallMode(
  requested: RuntimeServiceMode | undefined,
  config: RuntimeSlotState['config']
): RuntimeServiceMode {
  if (requested) return requested;
  const canConnect = Boolean(config.hubUrl);
  const canServe = Boolean(config.serveListen);
  if (canConnect && !canServe) return 'connect';
  if (canServe && !canConnect) return 'serve';
  if (!canConnect && !canServe) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unconfigured',
      'Neither connect nor serve is configured. Run "mangostudio-runtime connect --hub <url>" or "mangostudio-runtime serve --listen <host:port>" once first.'
    );
  }
  throw new RuntimeServiceManagementError(
    'runtime_service_unconfigured',
    'Pass --mode connect or --mode serve. Both modes look configured; the service unit runs only one subcommand.'
  );
}

function currentBinaryForService(
  slot: RuntimeSlot = PAIRED_SLOT,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return runtimeSlotCurrentBinaryPath(slot, homeOptions(env, platform));
}

export interface RuntimeServiceManager {
  install(mode: RuntimeServiceMode): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<RuntimeServiceStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export function createRuntimeServiceManager(
  deps: RuntimeServiceExecDeps = defaultUserServiceExecDeps()
): RuntimeServiceManager {
  const slot = PAIRED_SLOT;
  const options = () => homeOptions(deps.env, deps.platform);
  const currentBinary = () => currentBinaryForService(slot, deps.env, deps.platform);
  const manager = createUserServiceManager(RUNTIME_SERVICE_IDENTITY, deps);

  /**
   * `ExecStart` points at `current` so upgrades never strand the unit, which
   * only works once something has published bytes there. `setup`, `connect`
   * and `serve` all run happily from a binary sitting anywhere — a manually
   * downloaded one never populates the slot — so without this the install
   * "succeeds" and leaves an enabled unit that fails to start at every boot.
   */
  const assertCurrentBinaryInstalled = async (): Promise<void> => {
    const binaryPath = currentBinary();
    if (await deps.pathExists(binaryPath)) return;
    throw new RuntimeServiceManagementError(
      'runtime_service_binary_missing',
      [
        `No runtime binary at ${binaryPath}.`,
        'A unit pointing there would fail to start at every boot.',
        'Install this runtime into the slot first — upgrade it from its environment card, or push it over ssh — then install the service.',
        `See ${RUNTIME_SERVICE_DOCS_URL}`,
      ].join('\n')
    );
  };

  return {
    async install(mode) {
      const slotState = await readRuntimeSlotState(slot, deps.env);
      await assertServicePreconditions(mode, slotState, deps.env);
      await assertCurrentBinaryInstalled();
      await manager.install(runtimeUnitDefinition(currentBinary(), mode));
    },

    uninstall: () => manager.uninstall(),
    start: () => manager.start(),
    stop: () => manager.stop(),
    restart: () => manager.restart(),

    async status() {
      const slotState = await readRuntimeSlotState(slot, deps.env);
      const currentDir = runtimeSlotCurrentDir(slot, options());
      const configMode = inferConfiguredMode(slotState.config);
      const status = await manager.status();
      const body = await manager.readUnit();
      const mode = body ? (modeFromUnitBody(body) ?? configMode) : configMode;
      if (!status.installed || status.error) {
        return { ...status, mode };
      }
      return {
        ...status,
        mode,
        execUsesCurrent: body
          ? execStartUsesCurrent(body, currentDir)
          : status.execPath === currentBinary(),
        currentBinaryPresent: await deps.pathExists(currentBinary()),
      };
    },
  };
}

function modeFromUnitBody(body: string): RuntimeServiceMode | null {
  const execStart = body.match(/^ExecStart=(.+)$/m)?.[1]?.trim();
  if (execStart?.endsWith(' connect')) return 'connect';
  if (execStart?.endsWith(' serve')) return 'serve';
  const args = [...body.matchAll(/<string>(connect|serve)<\/string>/g)].map((match) => match[1]);
  const last = args.at(-1);
  if (last === 'connect' || last === 'serve') return last;
  return null;
}

function inferConfiguredMode(config: RuntimeSlotState['config']): RuntimeServiceMode | null {
  if (config.hubUrl && !config.serveListen) return 'connect';
  if (config.serveListen && !config.hubUrl) return 'serve';
  return null;
}

/** Whether doctor should inspect the user-level service for this health report. */
export function shouldCheckRuntimeService(report: {
  readonly slot: RuntimeSlot;
  readonly hubUrl?: string | null;
  readonly serveListen?: string | null;
}): boolean {
  if (report.slot !== 'remote') return false;
  return Boolean(report.hubUrl || report.serveListen);
}

export async function collectServiceDoctorDetails(
  env?: NodeJS.ProcessEnv,
  deps: RuntimeServiceExecDeps = defaultUserServiceExecDeps(env)
): Promise<{
  readonly status: RuntimeServiceStatus;
  readonly currentBinaryPath: string;
}> {
  const status = await createRuntimeServiceManager(deps).status();
  return {
    status,
    currentBinaryPath: currentBinaryForService(PAIRED_SLOT, deps.env, deps.platform),
  };
}
