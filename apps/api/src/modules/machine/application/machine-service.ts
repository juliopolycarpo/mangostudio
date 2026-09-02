/**
 * "This machine" as the hub sees it: the serving process, its service unit,
 * the sibling runtime, the host slot, doctor, and the log tail, plus the two
 * mutating actions the page may take. Every external read is injected so the
 * service is testable without a supervisor, a state file, or a running server.
 */

import type { UserServiceManager } from '@mangostudio/runtime';
import type { InstallGuard } from '@mangostudio/shared/environments';
import type {
  MachineActionReason,
  MachineActionResponse,
  MachineCheck,
  MachineDoctorReport,
  MachineDoctorSection,
  MachineLogTail,
  MachineServiceAction,
  MachineStatus,
} from '@mangostudio/shared/machine';
import { MACHINE_LOG_TAIL_DEFAULT, MACHINE_LOG_TAIL_MAX } from '@mangostudio/shared/machine';
import { resolveRuntimeSlotConfig, runtimeSlotDir } from '@mangostudio/shared/runtime-home';
import { spawnServeChild } from '../../../cli/detach';
import { probeHealth } from '../../../cli/health';
import { type LogTail, latestHubLogFile, readLogTail } from '../../../cli/log-tail';
import { createProcessController, type ProcessController } from '../../../cli/process-control';
import { probeRuntimeBinary, type RuntimeBinaryProbe } from '../../../cli/runtime-binary-probe';
import { probeRuntimeSlots, type RuntimeSlotProbe } from '../../../cli/runtime-slot-probe';
import {
  getConfig,
  getHomeMangoDir,
  getRuntimeHomeMangoDir,
  getVersion,
} from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getLogsDir, getServerLogPath } from '../../../lib/mango-paths';
import { isStandaloneExecutable } from '../../../lib/runtime-paths';
import { isStateLive, readState, type ServerState } from '../../../lib/server-state';
import { requestShutdown } from '../../../server/shutdown-request';
import type { HubExecutable } from '../domain/hub-executable';
import { describeHubProcess, hubLaunchMode } from '../domain/hub-process';
import { hubServiceUnitName } from '../domain/hub-service-identity';
import {
  INSTALL_SERVICE_COMMAND,
  installServiceReason,
  type MachineActionsInput,
  machineActions,
  RESTART_COMMAND,
  restartReason,
  UNINSTALL_SERVICE_COMMAND,
  uninstallServiceReason,
} from '../domain/machine-actions';
import { evaluateMachineActionGuard } from '../domain/machine-guard';
import { collectDoctorChecks, DEFAULT_DOCTOR_COLLECT_OPTIONS } from './doctor-service';
import {
  buildHubServiceDefinition,
  createHubServiceManager,
  currentHubExecutable,
  hubServiceLogPath,
  isAuthSecretPersisted,
} from './hub-service';

/** A mutating action was refused by the local-surface guard. */
export class MachineActionBlockedError extends Error {
  constructor(readonly guard: InstallGuard) {
    super(
      `This action is only available from a browser on the hub's own machine (${guard.reasons.join(', ')}).`
    );
    this.name = 'MachineActionBlockedError';
  }
}

/** A mutating action does not apply to how this hub is running; run `command` instead. */
export class MachineActionUnavailableError extends Error {
  constructor(
    readonly reason: MachineActionReason,
    readonly command: string
  ) {
    super(`This action is not available here (${reason}). Run "${command}" in a terminal instead.`);
    this.name = 'MachineActionUnavailableError';
  }
}

export interface MachineRequestContext {
  readonly clientIp: string | undefined;
}

/** Facts about the process and machine that never change while it runs. */
export interface MachineEnvironment {
  readonly platform: NodeJS.Platform;
  readonly standalone: boolean;
  readonly container: boolean;
  readonly serverHost: string;
  readonly serverPort: number;
  readonly homeDir: string;
  readonly logsDir: string;
  readonly configFile: string | null;
  readonly version: string;
  readonly hostSlotDir: string;
  readonly pid: number;
}

export interface MachineServiceDeps {
  readonly manager: UserServiceManager;
  readonly controller: ProcessController;
  readonly readState: typeof readState;
  readonly probeHealth: typeof probeHealth;
  readonly probeRuntimeBinary: () => Promise<RuntimeBinaryProbe>;
  readonly probeRuntimeSlots: () => Promise<RuntimeSlotProbe[]>;
  readonly collectDoctor: (sections: readonly MachineDoctorSection[]) => Promise<MachineCheck[]>;
  readonly readLogTail: (path: string, count: number) => Promise<LogTail | null>;
  readonly latestLogFile: () => Promise<string | null>;
  readonly evaluateGuard: (clientIp: string | undefined) => InstallGuard;
  readonly environment: () => MachineEnvironment;
  readonly executable: () => HubExecutable;
  readonly serviceLogFile: () => string;
  readonly secretPersisted: () => boolean;
  /** Spawn the detached successor that waits for this process before binding. */
  readonly spawnSuccessor: (state: ServerState) => void;
  /** Let go of the port and the state file, then exit. */
  readonly shutdown: () => void;
  /** Run after the response has left; the work may end this process. */
  readonly schedule: (work: () => Promise<void> | void) => void;
  readonly now: () => number;
  readonly env: NodeJS.ProcessEnv;
}

export interface MachineService {
  status(context: MachineRequestContext): Promise<MachineStatus>;
  doctor(sections: readonly MachineDoctorSection[]): Promise<MachineDoctorReport>;
  logs(tail: number, context: MachineRequestContext): Promise<MachineLogTail>;
  restart(context: MachineRequestContext): Promise<MachineActionResponse>;
  service(
    action: MachineServiceAction,
    context: MachineRequestContext
  ): Promise<MachineActionResponse>;
}

const AFTER_RESPONSE_MS = 50;
const logger = createDiagnosticLogger('machine');

/** Build the service. // Usage: createMachineService().status({ clientIp }) */
export function createMachineService(deps: Partial<MachineServiceDeps> = {}): MachineService {
  const d = resolveDeps(deps);

  const liveState = async (): Promise<ServerState | null> => {
    const state = await d.readState();
    if (!state) return null;
    return isStateLive(state, (pid) => d.controller.isAlive(pid)) ? state : null;
  };

  const actionsInput = async (
    clientIp: string | undefined,
    state: ServerState | null
  ): Promise<MachineActionsInput> => ({
    launch: state ? hubLaunchMode(state) : 'foreground',
    platform: d.environment().platform,
    service: await d.manager.status(),
    guard: d.evaluateGuard(clientIp),
    secretPersisted: d.secretPersisted(),
  });

  return {
    async status(context) {
      const environment = d.environment();
      const state = await liveState();
      const health =
        state === null
          ? undefined
          : state.pid === environment.pid || (await d.probeHealth(state.host, state.port))
            ? 'ok'
            : 'unreachable';
      const input = await actionsInput(context.clientIp, state);
      const [binary, slots] = await Promise.all([d.probeRuntimeBinary(), d.probeRuntimeSlots()]);
      const host = slots.find((slot) => slot.slot === 'host');
      return {
        hub: describeHubProcess({ state, alive: state !== null, now: d.now(), health }),
        service: input.service,
        runtimeBinary: {
          path: binary.path,
          present: binary.present,
          version: binary.version,
          versionMatches: binary.version === null ? null : binary.version === environment.version,
          error: binary.error,
        },
        hostSlot: host
          ? {
              present: true,
              profile: host.config.profile,
              directory: host.directory,
              error: host.error,
            }
          : {
              present: false,
              profile: resolveRuntimeSlotConfig('host', null, { source: 'provisioned' }).profile,
              directory: environment.hostSlotDir,
              error: null,
            },
        platform: environment.platform,
        standalone: environment.standalone,
        container: environment.container,
        homeDir: environment.homeDir,
        logsDir: environment.logsDir,
        configFile: environment.configFile,
        actions: machineActions(input),
      };
    },

    async doctor(sections) {
      const checks = await d.collectDoctor(sections);
      return {
        checks,
        warnings: checks.filter((check) => check.status === 'warn').length,
        failures: checks.filter((check) => check.status === 'fail').length,
      };
    },

    async logs(tail, context) {
      // Raw stdout and stderr, unredacted: error dumps land here whole. The
      // machine's own keyboard may read them; a signed-in remote session may not.
      const guard = d.evaluateGuard(context.clientIp);
      if (!guard.allowed) throw new MachineActionBlockedError(guard);
      const count = Math.min(Math.max(1, tail || MACHINE_LOG_TAIL_DEFAULT), MACHINE_LOG_TAIL_MAX);
      const state = await d.readState();
      const file = state?.logFile || (await d.latestLogFile());
      if (!file) return { file: null, lines: [], truncated: false };
      // A bounded suffix, not the whole file: `service.log` is append-only and
      // nothing rotates it, so a long-lived hub's log is not something a page
      // visit should read into memory end to end.
      const recent = await d.readLogTail(file, count);
      if (recent === null) return { file, lines: [], truncated: false };
      return { file, lines: recent.lines, truncated: recent.truncated };
    },

    async restart(context) {
      const state = await liveState();
      const input = await actionsInput(context.clientIp, state);
      refuse(restartReason(input), input.guard, RESTART_COMMAND);
      if (!state) throw new MachineActionUnavailableError('foreground', RESTART_COMMAND);

      if (input.launch === 'service') {
        d.schedule(() => d.manager.restart());
        return {
          accepted: true,
          message: `Restart requested through ${state.service}. The page reconnects when the server is back.`,
        };
      }
      d.schedule(() => {
        // Only let go once a successor exists; a failed spawn followed by a
        // shutdown would leave nothing serving.
        d.spawnSuccessor(state);
        d.shutdown();
      });
      return {
        accepted: true,
        message: 'Restarting in the background. The page reconnects when the server is back.',
      };
    },

    async service(action, context) {
      const state = await liveState();
      const input = await actionsInput(context.clientIp, state);
      if (action === 'install') {
        refuse(installServiceReason(input), input.guard, INSTALL_SERVICE_COMMAND);
        return await install(state, input);
      }
      refuse(uninstallServiceReason(input), input.guard, UNINSTALL_SERVICE_COMMAND);
      if (input.launch === 'service') {
        // The supervisor stops this process as part of removing the unit, so
        // the work runs after the response has gone out.
        d.schedule(() => d.manager.uninstall());
        return {
          accepted: true,
          message: `Removing ${state?.service ?? 'the service'}. This server stops with it; start it again with "mangostudio serve -d".`,
        };
      }
      await d.manager.uninstall();
      return { accepted: true, message: 'The service was removed. This server keeps running.' };
    },
  };

  async function install(
    state: ServerState | null,
    input: MachineActionsInput
  ): Promise<MachineActionResponse> {
    const environment = d.environment();
    const unitName = hubServiceUnitName(environment.platform);
    const explicitTarget =
      state && (state.host !== environment.serverHost || state.port !== environment.serverPort)
        ? { host: state.host, port: state.port }
        : undefined;
    const definition = buildHubServiceDefinition({
      executable: d.executable(),
      unitName,
      logFile: d.serviceLogFile(),
      env: d.env,
      platform: environment.platform,
      ...(explicitTarget ? { target: explicitTarget } : {}),
    });
    await d.manager.install(definition);

    if (input.launch === 'service' || state === null) {
      return { accepted: true, message: `Installed ${unitName}.` };
    }
    // The unit is starting and waiting for this process to let go; nothing
    // happens until this response has left.
    d.schedule(() => d.shutdown());
    return {
      accepted: true,
      message: `Installed ${unitName}. Handing over to it now; the page reconnects when it is up.`,
    };
  }
}

function refuse(reason: MachineActionReason | null, guard: InstallGuard, command: string): void {
  if (reason === null) return;
  if (reason === 'guard') throw new MachineActionBlockedError(guard);
  throw new MachineActionUnavailableError(reason, command);
}

function realEnvironment(): MachineEnvironment {
  const config = getConfig();
  return {
    platform: process.platform,
    standalone: isStandaloneExecutable(),
    container: config.environments.container,
    serverHost: config.server.host,
    serverPort: config.server.port,
    homeDir: getHomeMangoDir(),
    logsDir: getLogsDir(),
    configFile: config.configFilePath || null,
    version: getVersion(),
    hostSlotDir: runtimeSlotDir('host', {
      mangoHome: getRuntimeHomeMangoDir(),
      platform: process.platform,
    }),
    pid: process.pid,
  };
}

function resolveDeps(deps: Partial<MachineServiceDeps>): MachineServiceDeps {
  const environment = deps.environment ?? realEnvironment;
  return {
    manager: deps.manager ?? createHubServiceManager(),
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    probeHealth: deps.probeHealth ?? probeHealth,
    probeRuntimeBinary: deps.probeRuntimeBinary ?? (() => probeRuntimeBinary()),
    probeRuntimeSlots: deps.probeRuntimeSlots ?? (() => probeRuntimeSlots()),
    collectDoctor:
      deps.collectDoctor ??
      ((sections) => collectDoctorChecks({ ...DEFAULT_DOCTOR_COLLECT_OPTIONS, sections })),
    readLogTail: deps.readLogTail ?? readLogTail,
    latestLogFile: deps.latestLogFile ?? (() => latestHubLogFile(environment().logsDir)),
    evaluateGuard:
      deps.evaluateGuard ??
      ((clientIp) => {
        const env = environment();
        return evaluateMachineActionGuard({
          serverHost: env.serverHost,
          clientIp,
          standalone: env.standalone,
          container: env.container,
        });
      }),
    environment,
    executable: deps.executable ?? (() => currentHubExecutable()),
    serviceLogFile: deps.serviceLogFile ?? hubServiceLogPath,
    secretPersisted: deps.secretPersisted ?? (() => isAuthSecretPersisted()),
    spawnSuccessor:
      deps.spawnSuccessor ??
      ((state) => {
        spawnServeChild(state.port, state.host, getServerLogPath(Date.now()), {
          waitForPid: state.pid,
        });
      }),
    shutdown: deps.shutdown ?? requestShutdown,
    schedule:
      deps.schedule ??
      ((work) => {
        const timer = setTimeout(() => {
          void Promise.resolve()
            .then(work)
            .catch((error: unknown) => {
              // The response already said "accepted"; the log is the only
              // place left to say it was not.
              logger.error('deferred_action_failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }, AFTER_RESPONSE_MS);
        timer.unref?.();
      }),
    now: deps.now ?? Date.now,
    env: deps.env ?? process.env,
  };
}

export const machineService: MachineService = createMachineService();
