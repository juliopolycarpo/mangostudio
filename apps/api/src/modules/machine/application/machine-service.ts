/**
 * "This machine" as the hub sees it: the serving process, its service unit,
 * the sibling runtime, the host slot, doctor, and the log tail, plus the two
 * mutating actions the page may take. Every external read is injected so the
 * service is testable without a supervisor, a state file, or a running server.
 */

import { RuntimeServiceManagementError, type UserServiceManager } from '@mangostudio/runtime';
import type { InstallGuard } from '@mangostudio/shared/environments';
import type {
  HubHealth,
  MachineActionReason,
  MachineActionResponse,
  MachineCheck,
  MachineDoctorReport,
  MachineDoctorSection,
  MachineLogTail,
  MachineServiceAction,
  MachineStatus,
} from '@mangostudio/shared/machine';
import {
  MACHINE_ERROR_MAX,
  MACHINE_LOG_TAIL_DEFAULT,
  MACHINE_LOG_TAIL_MAX,
} from '@mangostudio/shared/machine';
import {
  resolveRuntimeSlotConfig,
  runtimeSlotDir,
  USER_SERVICE_ERROR_MAX,
  type UserServiceStatus,
} from '@mangostudio/shared/runtime-home';
import { spawnServeChild } from '../../../cli/detach';
import { canProbeHealth, probeHealth, probeHubHealth } from '../../../cli/health';
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
import { fitDoctorChecks, fitToLimit } from '../domain/machine-limits';
import { collectDoctorChecks, DEFAULT_DOCTOR_COLLECT_OPTIONS } from './doctor-service';
import {
  buildHubServiceDefinition,
  createHubServiceManager,
  currentHubExecutable,
  hubServiceLogPath,
  hubServiceTargetFor,
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
  readonly canProbeHealth: typeof canProbeHealth;
  readonly probeRuntimeBinary: () => Promise<RuntimeBinaryProbe>;
  readonly probeRuntimeSlots: () => Promise<RuntimeSlotProbe[]>;
  readonly collectDoctor: (
    sections: readonly MachineDoctorSection[],
    userId?: string
  ) => Promise<MachineCheck[]>;
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
  doctor(sections: readonly MachineDoctorSection[], userId?: string): Promise<MachineDoctorReport>;
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

  /** Assemble the action inputs around a service status already in hand. */
  const actionsInputFrom = (
    clientIp: string | undefined,
    state: ServerState | null,
    service: UserServiceStatus
  ): MachineActionsInput => ({
    launch: state ? hubLaunchMode(state) : 'foreground',
    platform: d.environment().platform,
    service,
    guard: d.evaluateGuard(clientIp),
    secretPersisted: d.secretPersisted(),
  });

  const actionsInput = async (
    clientIp: string | undefined,
    state: ServerState | null
  ): Promise<MachineActionsInput> => actionsInputFrom(clientIp, state, await d.manager.status());

  return {
    async status(context) {
      const environment = d.environment();
      // Only the health probe needs the state file; the supervisor query and the
      // two runtime probes each spawn work of their own and depend on nothing
      // but the request, so they are asked for together rather than in turn.
      const [state, service, binary, slots] = await Promise.all([
        liveState(),
        d.manager.status(),
        d.probeRuntimeBinary(),
        d.probeRuntimeSlots(),
      ]);
      const health = state === null ? undefined : await resolveHealth(state, environment, d);
      const input = actionsInputFrom(context.clientIp, state, service);
      const host = slots.find((slot) => slot.slot === 'host');
      return {
        hub: describeHubProcess({ state, alive: state !== null, now: d.now(), health }),
        // A supervisor's stderr is whatever it printed; the contract caps it.
        service: {
          ...input.service,
          ...(input.service.error === undefined
            ? {}
            : { error: fitToLimit(input.service.error, USER_SERVICE_ERROR_MAX) }),
        },
        runtimeBinary: {
          path: binary.path,
          present: binary.present,
          version: binary.version,
          versionMatches: binary.version === null ? null : binary.version === environment.version,
          error: fitToLimit(binary.error, MACHINE_ERROR_MAX),
        },
        hostSlot: host
          ? {
              present: true,
              profile: host.config.profile,
              directory: host.directory,
              error: fitToLimit(host.error, MACHINE_ERROR_MAX),
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

    async doctor(sections, userId) {
      // Scoped to the caller: the rows name MCP servers and connectors, which
      // belong to an account rather than to the machine.
      const checks = fitDoctorChecks(await d.collectDoctor(sections, userId));
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
          outcome: 'restarting-service',
          ...(state.service && { unit: state.service }),
        };
      }
      d.schedule(() => {
        // Only let go once a successor exists; a failed spawn followed by a
        // shutdown would leave nothing serving.
        d.spawnSuccessor(state);
        d.shutdown();
      });
      return { accepted: true, outcome: 'restarting-detached' };
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
          outcome: 'service-removing',
          ...(state?.service && { unit: state.service }),
        };
      }
      await d.manager.uninstall();
      return { accepted: true, outcome: 'service-removed' };
    },
  };

  async function install(
    state: ServerState | null,
    input: MachineActionsInput
  ): Promise<MachineActionResponse> {
    const environment = d.environment();
    const unitName = hubServiceUnitName(environment.platform);
    const explicitTarget = hubServiceTargetFor(state, {
      host: environment.serverHost,
      port: environment.serverPort,
    });
    const definition = buildHubServiceDefinition({
      executable: d.executable(),
      unitName,
      logFile: d.serviceLogFile(),
      env: d.env,
      platform: environment.platform,
      ...(explicitTarget ? { target: explicitTarget } : {}),
    });
    try {
      await d.manager.install(definition);
    } catch (error) {
      // The supervisor's own reason (a command over Task Scheduler's argument
      // limit, an unwritable unit file, ...) is diagnostic detail for the log,
      // not wire content: `MachineActionUnavailableError` carries a reason the
      // dictionaries can word, same as every other refusal this route answers.
      if (error instanceof RuntimeServiceManagementError) {
        logger.error('install_refused', { kind: error.kind, error: error.message });
        throw new MachineActionUnavailableError('install-failed', INSTALL_SERVICE_COMMAND);
      }
      throw error;
    }

    if (input.launch === 'service' || state === null) {
      return { accepted: true, outcome: 'service-installed', unit: unitName };
    }
    // The unit is starting and waiting for this process to let go; nothing
    // happens until this response has left.
    d.schedule(() => d.shutdown());
    return { accepted: true, outcome: 'service-installed-handover', unit: unitName };
  }
}

function refuse(reason: MachineActionReason | null, guard: InstallGuard, command: string): void {
  if (reason === null) return;
  if (reason === 'guard') throw new MachineActionBlockedError(guard);
  throw new MachineActionUnavailableError(reason, command);
}

/**
 * Whether the recorded process is answering. This process is answering by
 * definition — it is serving the request; anything else goes through the shared
 * probe rule.
 */
async function resolveHealth(
  state: ServerState,
  environment: MachineEnvironment,
  d: MachineServiceDeps
): Promise<HubHealth> {
  if (state.pid === environment.pid) return 'ok';
  return await probeHubHealth(state.host, state.port, d);
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
    canProbeHealth: deps.canProbeHealth ?? canProbeHealth,
    probeRuntimeBinary: deps.probeRuntimeBinary ?? (() => probeRuntimeBinary()),
    probeRuntimeSlots: deps.probeRuntimeSlots ?? (() => probeRuntimeSlots()),
    collectDoctor:
      deps.collectDoctor ??
      ((sections, userId) =>
        collectDoctorChecks({
          ...DEFAULT_DOCTOR_COLLECT_OPTIONS,
          sections,
          ...(userId === undefined ? {} : { userId }),
        })),
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
