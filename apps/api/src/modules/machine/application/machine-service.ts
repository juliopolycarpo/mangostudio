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
  MachineConfigWriteBody,
  MachineConfigWriteResponse,
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
import {
  type MachineUpdateStatus,
  type MachineUpgradeBody,
  SOURCE_SHA_MAX,
  UPDATE_ERROR_MAX,
  UPDATE_VERSION_MAX,
  UPGRADE_COMMAND_MAX,
  type UpdateChannel,
  type UpdateCheck,
  type UpgradeRefusalReason,
  type UpgradeReport,
  type UpgradeStreamEvent,
} from '@mangostudio/shared/updates';
import { stringify as stringifyToml } from 'smol-toml';
import { restartExecutableOptions, spawnServeChild } from '../../../cli/detach';
import { canProbeHealth, probeHealth, probeHubHealth } from '../../../cli/health';
import {
  type LogTail,
  latestHubLogFile,
  readLogTail,
  resolveHubLogFile,
} from '../../../cli/log-tail';
import { createProcessController, type ProcessController } from '../../../cli/process-control';
import { probeRuntimeBinary, type RuntimeBinaryProbe } from '../../../cli/runtime-binary-probe';
import { probeRuntimeSlots, type RuntimeSlotProbe } from '../../../cli/runtime-slot-probe';
import {
  getConfig,
  getHomeMangoDir,
  getRuntimeHomeMangoDir,
  getVersion,
  resetConfig,
} from '../../../lib/config';
import { bridgeEmitter } from '../../../lib/emit-bridge';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getLogsDir, getServerLogPath } from '../../../lib/mango-paths';
import { isStandaloneExecutable } from '../../../lib/runtime-paths';
import { writeFileAtomic } from '../../../lib/safe-file';
import { readLiveState, readState, type ServerState } from '../../../lib/server-state';
import { readTomlDocument, setTomlSectionValue } from '../../../lib/toml';
import { requestShutdown } from '../../../server/shutdown-request';
import {
  resolveInstallStatus,
  upgradeRefusalReason,
} from '../../updates/application/install-status';
import { type UpdateChecker, updateChecker } from '../../updates/application/update-check';
import {
  createUpgradeService,
  type UpgradeRunRequest,
  type UpgradeService,
} from '../../updates/application/upgrade-service';
import { fitInstalledVia, type InstallOriginProbe } from '../../updates/domain/install-origin';
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
  currentInstallOriginProbe,
  hubServiceLogPath,
  hubServiceTargetFor,
  isAuthSecretPersisted,
  realPathOrSelf,
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

/**
 * `POST /machine/upgrade` was asked for a plan this hub does not carry out
 * itself. Its own error type, not `MachineActionUnavailableError`: an
 * upgrade refusal reason (`package-manager`, `container`, ...) is a
 * different enum than `MachineActionReason`, and widening that shared schema
 * for one route is not warranted when a second error type does the job.
 */
export class UpgradeUnavailableError extends Error {
  constructor(
    readonly reason: UpgradeRefusalReason,
    readonly command: string
  ) {
    super(`This action is not available here (${reason}). Run "${command}" in a terminal instead.`);
    this.name = 'UpgradeUnavailableError';
  }
}

/** What a caller refused with `'in-progress'` should run instead, to see how the running upgrade ends. */
const STATUS_COMMAND = 'mangostudio status';

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
  /** The canonical user config.toml path; never a hard-coded `~/.mango`. */
  readonly configFilePath: () => string;
  /** Follows a symlinked `config.toml` (dotfiles) so the read and the write name the same file. */
  readonly resolveConfigPath: (path: string) => string;
  readonly readConfigDocument: (path: string) => Record<string, unknown>;
  readonly writeConfigFile: (path: string, contents: string) => void;
  /**
   * Reloads the in-process config from disk and reports the effective
   * `installsEnabled` afterward — not what was just written, because `.env`
   * beside `config.toml` can override it. Injected so a test can script the
   * override without the real singleton's test-runner sandbox getting in the
   * way (`getConfig()` never touches disk under `bun test`).
   */
  readonly reloadEffectiveInstallsEnabled: () => boolean;
  /** Spawn the detached successor that waits for this process before binding. */
  readonly spawnSuccessor: (state: ServerState) => void;
  /** Let go of the port and the state file, then exit. */
  readonly shutdown: () => void;
  /** Run after the response has left; the work may end this process. */
  readonly schedule: (work: () => Promise<void> | void) => void;
  readonly now: () => number;
  readonly env: NodeJS.ProcessEnv;
  /** How this binary was installed, freshly probed each call. */
  readonly installOriginProbe: () => InstallOriginProbe;
  /** `config.updates`, re-read each call so a reload takes effect immediately. */
  readonly updatesConfig: () => { readonly check: boolean; readonly channel: UpdateChannel | null };
  readonly checker: Pick<UpdateChecker, 'readCached' | 'check'>;
  /**
   * The upgrade engine, wired with a no-op `restartHub`: this route defers
   * the actual restart until after the SSE stream has ended (see `upgrade`
   * below), the same way `restart()` above defers through `schedule`.
   */
  readonly upgradeService: UpgradeService;
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
  writeConfig(
    body: MachineConfigWriteBody,
    context: MachineRequestContext
  ): Promise<MachineConfigWriteResponse>;
  update(context: MachineRequestContext): Promise<MachineUpdateStatus>;
  /**
   * Stream an upgrade. The guard and the plan check both happen before the
   * promise resolves, so a caller can `await` this and map a thrown
   * `MachineActionBlockedError`/`UpgradeUnavailableError` to 403/409 before
   * ever opening the response stream.
   */
  upgrade(
    body: MachineUpgradeBody,
    context: MachineRequestContext
  ): Promise<AsyncIterable<UpgradeStreamEvent>>;
}

const AFTER_RESPONSE_MS = 50;
const logger = createDiagnosticLogger('machine');

/** Build the service. // Usage: createMachineService().status({ clientIp }) */
export function createMachineService(deps: Partial<MachineServiceDeps> = {}): MachineService {
  const d = resolveDeps(deps);

  // A page can hold a banner and a card that both offer Upgrade, and a second
  // tab is free to open the same page: without this, two concurrent
  // `upgrade()` calls would both stage into the same
  // `.staging-<version>-<pid>` directory (the engine keys it off this
  // process's own pid) and race the download and the install script. One
  // flag is enough — the service is a singleton and only one upgrade at a
  // time makes sense for it to run.
  let upgradeInFlight = false;

  const liveState = (): Promise<ServerState | null> =>
    readLiveState(d.readState, (pid) => d.controller.isAlive(pid));

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
      const file = await resolveHubLogFile(() => d.readState(), d.latestLogFile);
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
      await throughSupervisor(
        () => d.manager.uninstall(),
        'uninstall-failed',
        UNINSTALL_SERVICE_COMMAND
      );
      return { accepted: true, outcome: 'service-removed' };
    },

    // Every dependency this touches is synchronous (file I/O and the config
    // singleton are both sync APIs); the interface stays `Promise`-returning
    // like its siblings so a caller never has to know that. Every failure —
    // the guard's, an unreadable file's — leaves as a rejection, so a caller
    // awaiting the promise is always the one that sees it.
    writeConfig(body, context) {
      try {
        return Promise.resolve(writeConfigNow(body, context));
      } catch (error) {
        return Promise.reject(error);
      }
    },

    // Every read here is synchronous; `check()` below is deliberately not
    // awaited, so nothing in this method actually suspends. `Promise`-returning
    // for the same reason `writeConfig` is: callers never have to know that.
    update(context) {
      const { check: checksEnabled, channel: configuredChannel } = d.updatesConfig();
      // The probe already carries the running version; building a whole
      // `MachineEnvironment` (config, home/logs dirs, runtime slot dir) to read
      // one string off it is work this request has no other use for.
      const probe = d.installOriginProbe();
      const status = resolveInstallStatus(probe, configuredChannel, probe.version);
      if (checksEnabled) {
        // The cache the response reads below; the checker itself decides
        // whether it is still fresh enough to skip the network.
        void d.checker.check().catch(() => undefined);
      }
      const check = checksEnabled ? d.checker.readCached() : null;
      const reason = upgradeRefusalReason(status.plan);
      // A remote signed-in reader can see this page but must not be offered
      // the button: `canUpgrade` folds the same loopback guard `upgrade()`
      // itself enforces, so a stale "can upgrade" answer never survives past
      // the guard that would actually refuse the POST.
      const canUpgrade = status.plan.kind === 'self' && d.evaluateGuard(context.clientIp).allowed;
      return Promise.resolve({
        installedVia: fitInstalledVia(status.installedVia),
        channel: status.channel,
        check: check ? fitUpdateCheck(check) : null,
        checksEnabled,
        canUpgrade,
        ...(reason !== undefined ? { reason } : {}),
        command: fitToLimit(status.command, UPGRADE_COMMAND_MAX),
      });
    },

    // The guard and the plan lookup are both synchronous; wrapping in
    // Promise.resolve/reject (rather than declaring this async, which would
    // trip the no-idle-await lint) keeps every failure a rejection the same
    // way writeConfig above does, so a caller `await`ing this never has to
    // tell a thrown guard error apart from a rejected one.
    upgrade(body, context) {
      try {
        return Promise.resolve(upgradeNow(body, context));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };

  function upgradeNow(
    body: MachineUpgradeBody,
    context: MachineRequestContext
  ): AsyncIterable<UpgradeStreamEvent> {
    const guard = d.evaluateGuard(context.clientIp);
    if (!guard.allowed) throw new MachineActionBlockedError(guard);
    if (upgradeInFlight) throw new UpgradeUnavailableError('in-progress', STATUS_COMMAND);

    const { channel: configuredChannel } = d.updatesConfig();
    const probe = d.installOriginProbe();
    const status = resolveInstallStatus(probe, configuredChannel, probe.version, {
      channel: body.channel,
      version: body.version,
      sha: body.sha,
    });
    if (status.plan.kind !== 'self') {
      const reason = upgradeRefusalReason(status.plan) ?? 'unknown-origin';
      throw new UpgradeUnavailableError(reason, status.command);
    }

    upgradeInFlight = true;
    return upgradeEvents(body, d, liveState, () => {
      upgradeInFlight = false;
    });
  }

  function writeConfigNow(
    body: MachineConfigWriteBody,
    context: MachineRequestContext
  ): MachineConfigWriteResponse {
    // The same loopback-only surface every mutating machine action shares —
    // no `installsEnabled` reason has meaning here, since this is the very
    // switch that turns it on.
    const guard = d.evaluateGuard(context.clientIp);
    if (!guard.allowed) throw new MachineActionBlockedError(guard);

    // A symlinked config.toml (dotfiles) is read through the link's target
    // and written there too; the bounded reader refuses to follow links.
    const configFile = d.resolveConfigPath(d.configFilePath());
    const doc = d.readConfigDocument(configFile);
    setTomlSectionValue(doc, 'environments', 'installs_enabled', body.environments.installsEnabled);
    d.writeConfigFile(configFile, stringifyToml(doc));

    // The write always happens — even under an env override, the file is
    // meant to say `true` from now on — but the response never claims
    // success for a switch that did not actually move.
    const installsEnabled = d.reloadEffectiveInstallsEnabled();
    return installsEnabled
      ? { applied: true, configFile, installsEnabled }
      : { applied: false, configFile, installsEnabled, reason: 'env-override' };
  }

  /**
   * Run one supervisor verb, turning its own refusal into a coded reason. The
   * manager's message names a missing session bus, an unwritable unit file or a
   * command over Task Scheduler's limit — diagnostic detail for the log, not
   * wire content: `MachineActionUnavailableError` carries a reason the
   * dictionaries can word, same as every other refusal this route answers, and
   * a bare `RuntimeServiceManagementError` would reach the page as a 500.
   */
  async function throughSupervisor(
    work: () => Promise<void>,
    reason: 'install-failed' | 'uninstall-failed',
    command: string
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof RuntimeServiceManagementError)) throw error;
      logger.error('supervisor_refused', {
        reason,
        kind: error.kind,
        error: error.message,
      });
      throw new MachineActionUnavailableError(reason, command);
    }
  }

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
    await throughSupervisor(
      () => d.manager.install(definition),
      'install-failed',
      INSTALL_SERVICE_COMMAND
    );

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
 * Bridges the engine's `emit` callback into the SSE source `upgrade()`
 * returns, then — once the caller has drained it — schedules the real
 * restart in a `finally`, so a client that disconnects mid-stream (`cancel()`
 * → the generator never resumes past its last `yield`) still gets the
 * restart it was promised, not just one that completed normally.
 */
async function* upgradeEvents(
  body: MachineUpgradeBody,
  d: MachineServiceDeps,
  liveState: () => Promise<ServerState | null>,
  onDone: () => void
): AsyncGenerator<UpgradeStreamEvent> {
  const request: UpgradeRunRequest = {
    ...(body.channel !== undefined ? { channel: body.channel } : {}),
    ...(body.version !== undefined ? { version: body.version } : {}),
    ...(body.sha !== undefined ? { sha: body.sha } : {}),
    restart: body.restart ?? true,
  };
  const bridge = bridgeEmitter<UpgradeStreamEvent, UpgradeReport>((emit) =>
    d.upgradeService.run(request, emit)
  );

  try {
    yield* bridge.items;
    const report = bridge.result();
    if (report) yield { type: 'done', done: true, ...report };
  } finally {
    // Frees a second `upgrade()` call to start the moment this one stops
    // being watched — whether the stream ran to its `done` event or the
    // client disconnected mid-way. The engine itself may still be finishing
    // up in the background (see below); `upgrade-service.ts`'s own
    // in-flight guard is what keeps that from racing a second `run()`.
    onDone();
    // Runs whether the stream ended normally or the client disconnected
    // mid-way (`cancel()` stops `bridge.items` short of its last `yield`,
    // which would otherwise skip scheduling a restart the upgrade already
    // earned). `bridge.result()` is only set once the engine has actually
    // settled; still undefined here means the client left before the engine
    // finished. The engine keeps running regardless (it never reads from
    // this generator), so wait for `bridge.settled` instead of giving up —
    // fire-and-forget, so a slow download does not hold `iterator.return()`
    // open for the caller.
    const report = bridge.result();
    if (report !== undefined) {
      await scheduleRestartIfNeeded(report, d, liveState);
    } else {
      void bridge.settled.then(
        (finalReport) => scheduleRestartIfNeeded(finalReport, d, liveState),
        () => undefined
      );
    }
  }
}

async function scheduleRestartIfNeeded(
  report: UpgradeReport,
  d: MachineServiceDeps,
  liveState: () => Promise<ServerState | null>
): Promise<void> {
  if (report.restart !== 'scheduled') return;
  const state = await liveState();
  if (!state) return;
  // Mirrors `restart()`: a service-supervised hub must ask its supervisor to
  // restart it, not spawn a successor and exit — a systemd unit with
  // `KillMode=control-group` would tear down the successor along with this
  // process, and launchd would lose track of it as an orphan.
  if (hubLaunchMode(state) === 'service') {
    d.schedule(() => d.manager.restart());
    return;
  }
  d.schedule(() => {
    d.spawnSuccessor(state);
    d.shutdown();
  });
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
  const executable = deps.executable ?? (() => currentHubExecutable());
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
    executable,
    serviceLogFile: deps.serviceLogFile ?? hubServiceLogPath,
    secretPersisted: deps.secretPersisted ?? (() => isAuthSecretPersisted()),
    configFilePath: deps.configFilePath ?? (() => getConfig().configFilePath),
    resolveConfigPath: deps.resolveConfigPath ?? realPathOrSelf,
    readConfigDocument: deps.readConfigDocument ?? readTomlDocument,
    writeConfigFile: deps.writeConfigFile ?? ((path, contents) => writeFileAtomic(path, contents)),
    reloadEffectiveInstallsEnabled:
      deps.reloadEffectiveInstallsEnabled ??
      (() => {
        resetConfig();
        return getConfig().environments.installsEnabled;
      }),
    spawnSuccessor:
      deps.spawnSuccessor ??
      ((state) => {
        spawnServeChild(state.port, state.host, getServerLogPath(Date.now()), {
          waitForPid: state.pid,
          ...restartExecutableOptions(executable()),
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
    installOriginProbe: deps.installOriginProbe ?? currentInstallOriginProbe,
    updatesConfig: deps.updatesConfig ?? (() => getConfig().updates),
    checker: deps.checker ?? updateChecker,
    // A no-op restartHub: this process is the hub the upgrade would restart,
    // so the actual restart is scheduled by upgradeEvents() above, after the
    // SSE stream has ended — never by the engine itself mid-request.
    upgradeService:
      deps.upgradeService ?? createUpgradeService({ restartHub: () => Promise.resolve() }),
  };
}

/** `UpdateCheck` cut to the wire caps — the release host's own answer is untrusted length. */
function fitUpdateCheck(check: UpdateCheck): UpdateCheck {
  return {
    channel: check.channel,
    currentVersion: fitToLimit(check.currentVersion, UPDATE_VERSION_MAX),
    ...(check.latestVersion !== undefined
      ? { latestVersion: fitToLimit(check.latestVersion, UPDATE_VERSION_MAX) }
      : {}),
    ...(check.latestSourceSha !== undefined
      ? { latestSourceSha: fitToLimit(check.latestSourceSha, SOURCE_SHA_MAX) }
      : {}),
    updateAvailable: check.updateAvailable,
    checkedAt: check.checkedAt,
    ...(check.error !== undefined ? { error: fitToLimit(check.error, UPDATE_ERROR_MAX) } : {}),
  };
}

export const machineService: MachineService = createMachineService();
