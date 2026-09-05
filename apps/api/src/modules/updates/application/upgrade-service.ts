/**
 * `mangostudio upgrade`'s engine: resolve a target, download and verify it,
 * run the embedded install script, and restart the hub — or hand the job to
 * the package manager that owns the binary, or refuse with the command that
 * would do it instead. The CLI and `POST /api/machine/upgrade` are both thin
 * callers of `run()`/`rollback()`; every branch they need lives here once.
 *
 * Every external effect is injected, and `run`/`rollback` never reject: a
 * throw from any of them (a network error, a spawn failure) becomes a
 * `failed` report with exit 2, the same as a script that ran and exited
 * non-zero. A caller streaming this over SSE can therefore always end with a
 * `done` event built from the return value, never an `error` event from a
 * rejected promise.
 */

import { mkdir, rm } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { HubLaunchMode } from '@mangostudio/shared/machine';
import {
  SOURCE_SHA_MAX,
  UPDATE_ERROR_MAX,
  UPDATE_VERSION_MAX,
  UPGRADE_COMMAND_MAX,
  UPGRADE_OUTPUT_LINE_MAX,
  type UpdateChannel,
  type UpgradeOutcome,
  type UpgradeRefusalReason,
  type UpgradeReport,
  type UpgradeRestart,
  type UpgradeStage,
  type UpgradeStreamEvent,
  type UpgradeTarget,
} from '@mangostudio/shared/updates';
import {
  DETACH_ENV_ALLOWLIST,
  pickAllowedEnv,
  restartExecutableOptions,
  type SpawnDetachedWaiterInput,
  spawnDetached,
  spawnDetachedWaiter,
} from '../../../cli/detach';
import {
  createProcessController,
  STOP_POLL_INTERVAL_MS,
  STOP_TIMEOUT_MS,
  stopPidOrThrow,
  waitForExit,
} from '../../../cli/process-control';
import { sleep } from '../../../cli/sleep';
import { type BuildInfo, getBuildInfo, isKnownBuildSha } from '../../../lib/build-info';
import { getConfig, getVersion, RUNTIME_CONFIG_ENV_KEYS } from '../../../lib/config';
import { getUpgradeLogPath } from '../../../lib/mango-paths';
import type { SafeFetchDeps } from '../../../lib/safe-fetch';
import { readLiveState, readState, type ServerState } from '../../../lib/server-state';
import {
  createHubServiceManager,
  currentHubExecutable,
  currentInstallOriginProbe,
} from '../../machine/application/hub-service';
import type { HubExecutable } from '../../machine/domain/hub-executable';
import { hubLaunchMode } from '../../machine/domain/hub-process';
import { fitToLimit } from '../../machine/domain/machine-limits';
import { decideRestart } from '../domain/decide-restart';
import {
  fitInstalledVia,
  type InstallOrigin,
  type InstallOriginProbe,
} from '../domain/install-origin';
import { type ReleasePlatformId, resolveBuildPlatformId } from '../domain/platform-id';
import {
  isAlreadyCurrent,
  type ResolvedDownload,
  resolveUpgradeTarget as resolveUpgradeTargetImpl,
  type UpgradeTargetContext,
  type UpgradeTargetRequest,
} from '../domain/resolve-target';
import type { UpgradePlan } from '../domain/upgrade-plan';
import type { InstallerKind } from '../infrastructure/embedded-installers';
import {
  buildScriptEnv,
  installerArgv,
  selfInstallFlags,
  useVersionFlags,
  writeTempScriptReal,
} from '../infrastructure/installer-invocation';
import {
  type DownloadedUpgrade,
  downloadVerified as downloadVerifiedImpl,
} from '../infrastructure/release-download';
import {
  type RunScript,
  runScript as runScriptImpl,
  type ScriptOutputLine,
  type ScriptRun,
} from '../infrastructure/run-script';
import { resolveInstallStatus } from './install-status';

export interface UpgradeRunRequest {
  readonly channel?: UpdateChannel;
  readonly version?: string;
  readonly sha?: string;
  readonly restart: boolean;
  readonly checkOnly?: boolean;
}

export type EmitUpgradeEvent = (event: UpgradeStreamEvent) => void;

export interface RollbackOptions {
  /** Whether to restart the hub once the rollback's pointer swap succeeds. Defaults to true. */
  readonly restart?: boolean;
}

export interface UpgradeService {
  run(request: UpgradeRunRequest, emit: EmitUpgradeEvent): Promise<UpgradeReport>;
  rollback(emit: EmitUpgradeEvent, options?: RollbackOptions): Promise<UpgradeReport>;
}

export interface UpgradeServiceDeps {
  /** Same shape `resolveInstallStatus`/`detectInstallOrigin` read; freshly probed each call. */
  readonly probe: () => InstallOriginProbe;
  readonly configuredChannel: () => UpdateChannel | null;
  readonly resolveUpgradeTarget: (
    request: UpgradeTargetRequest,
    context: UpgradeTargetContext
  ) => ReturnType<typeof resolveUpgradeTargetImpl>;
  readonly downloadVerified: (
    resolved: ResolvedDownload,
    destinationDir: string
  ) => Promise<DownloadedUpgrade>;
  readonly runScript: RunScript;
  readonly writeTempScript: (directory: string, kind: InstallerKind) => Promise<string>;
  readonly which: (name: string) => string | null;
  readonly mkdir: (path: string) => Promise<void>;
  readonly removeDir: (path: string) => Promise<void>;
  readonly spawnDetachedWaiter: (input: SpawnDetachedWaiterInput) => number;
  /**
   * Stop a live hub and return once its pid is gone — the Windows delegate's
   * precondition, since the package manager cannot replace `mangostudio.exe`
   * while a hub holds it open and nothing else in that flow makes one exit.
   */
  readonly stopHub: (input: { state: ServerState; launch: HubLaunchMode }) => Promise<void>;
  /** Effect for a `'scheduled'` restart decision; a route defers this itself instead (see machine-routes.ts). */
  readonly restartHub: (input: { state: ServerState; launch: HubLaunchMode }) => Promise<void>;
  readonly currentExecutable: () => HubExecutable;
  readonly readState: typeof readState;
  /** Whether the state file's pid is a live process — see `isStateLive`. */
  readonly isAlive: (pid: number) => boolean;
  readonly now: () => number;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly getVersion: () => string;
  readonly getBuildInfo: () => BuildInfo;
  readonly platformId: ReleasePlatformId;
  readonly pid: number;
}

/** Path joining that follows the deps' platform, not the one running the process — see hub-executable.ts's `joiner`. */
function joinPath(platform: NodeJS.Platform, ...segments: string[]): string {
  return (platform === 'win32' ? win32.join : posix.join)(...segments);
}

/**
 * A `.staging-<version>-<pid>`/`.rollback-<version>-<pid>` scratch directory
 * under `root`, refusing to resolve outside it. The schema and CLI layers
 * reject a `version` shaped like a path traversal before it reaches here, but
 * `resolve-target.ts`'s canary manifest and a hand-edited `install-origin.json`
 * both feed a version into this join without going through either — this is
 * the last check before `mkdir`/`rm -rf` ever sees the result.
 */
function resolveContainedStagingDir(platform: NodeJS.Platform, root: string, name: string): string {
  const path = platform === 'win32' ? win32 : posix;
  const candidate = joinPath(platform, root, name);
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const withinRoot =
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
  if (!withinRoot) {
    throw new Error(`Staging directory resolves outside the install root: ${candidate}`);
  }
  return candidate;
}

function stageEvent(stage: UpgradeStage, detail?: string): UpgradeStreamEvent {
  return detail !== undefined
    ? { type: 'stage', stage, detail, done: false }
    : { type: 'stage', stage, done: false };
}

function outputEvent(line: ScriptOutputLine): UpgradeStreamEvent {
  return {
    type: 'output',
    stream: line.stream,
    line: fitToLimit(line.line, UPGRADE_OUTPUT_LINE_MAX),
    done: false,
  };
}

/** Relays every line of a script run as an `output` event and resolves its exit code. */
async function relayLines(run: ScriptRun, emit: EmitUpgradeEvent): Promise<number> {
  for await (const line of run.lines) emit(outputEvent(line));
  return await run.exitCode;
}

/** A resolved download, cut to the wire `UpgradeTarget` shape — no internal verification fields. */
function toWireTarget(resolved: ResolvedDownload): UpgradeTarget {
  return {
    channel: resolved.channel,
    version: fitToLimit(resolved.version, UPDATE_VERSION_MAX),
    ...(resolved.sourceSha !== undefined
      ? { sourceSha: fitToLimit(resolved.sourceSha, SOURCE_SHA_MAX) }
      : {}),
    assetName: fitToLimit(resolved.assetName, 256),
    url: fitToLimit(resolved.url, 2_048),
    kind: resolved.kind,
    verification: resolved.verification,
  };
}

function joinMessages(...parts: readonly (string | undefined)[]): string | undefined {
  const filtered = parts.filter((part): part is string => Boolean(part?.trim()));
  return filtered.length > 0 ? filtered.join(' ') : undefined;
}

/**
 * Env a package-manager delegate runs with (see `delegateEnv`): the system and networking
 * essentials `DETACH_ENV_ALLOWLIST` already curates (including the proxy
 * variables), minus `RUNTIME_CONFIG_ENV_KEYS` — `DETACH_ENV_ALLOWLIST` is
 * built for the hub's own detached re-exec, which needs its runtime
 * configuration (BETTER_AUTH_SECRET, connector settings) to keep serving the
 * same config; a delegate is a different program entirely (`npm`/`brew`/
 * `cargo`) and has no business seeing them. Named vars a manager's own
 * install docs point at, plus the prefixes npm/Homebrew set a family of
 * config keys under, are added on top.
 */
const DELEGATE_ENV_ALLOWLIST: readonly string[] = [...DETACH_ENV_ALLOWLIST].filter(
  (key) => !RUNTIME_CONFIG_ENV_KEYS.includes(key)
);
const DELEGATE_ENV_EXTRA_NAMES: readonly string[] = ['CARGO_HOME', 'RUSTUP_HOME'];
const DELEGATE_ENV_PREFIXES: readonly string[] = ['npm_config_', 'HOMEBREW_'];

/**
 * The env a package-manager delegate runs with, on either platform: the
 * POSIX in-process run and the Windows detached waiter (whose `powershell.exe`
 * execs the same manager, and whose postinstall hooks inherit the same env)
 * must agree, so neither can reach the hub's secrets.
 * // Usage: delegateEnv(process.env)
 */
export function delegateEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return pickAllowedEnv(
    env,
    [...DELEGATE_ENV_ALLOWLIST, ...DELEGATE_ENV_EXTRA_NAMES],
    DELEGATE_ENV_PREFIXES
  );
}

/**
 * What each outcome exits with, stated once: 0 for an outcome the caller can
 * act on (upgraded, already current, a `--check` preview), 1 for a refusal,
 * 2 for a failure — including a script that ran and exited non-zero, whose own
 * code is named in the message rather than passed through here.
 */
const OUTCOME_EXIT_CODES: Record<UpgradeOutcome, number> = {
  upgraded: 0,
  'already-current': 0,
  available: 0,
  refused: 1,
  failed: 2,
};

interface ReportExtras {
  readonly target?: ResolvedDownload;
  readonly reason?: UpgradeRefusalReason;
  readonly command?: string;
  readonly restart?: UpgradeRestart;
  readonly logFile?: string;
  readonly message?: string;
}

/**
 * One `UpgradeReport`, with the wire caps and the exit-code table applied in a
 * single place — every outcome this engine can return goes through here.
 * // Usage: report('refused', installedVia, version, { reason: 'package-manager', command })
 */
function report(
  outcome: UpgradeOutcome,
  installedVia: InstallOrigin,
  currentVersion: string,
  extras: ReportExtras = {}
): UpgradeReport {
  return {
    outcome,
    installedVia: fitInstalledVia(installedVia),
    currentVersion,
    ...(extras.target ? { target: toWireTarget(extras.target) } : {}),
    ...(extras.reason ? { reason: extras.reason } : {}),
    ...(extras.command !== undefined
      ? { command: fitToLimit(extras.command, UPGRADE_COMMAND_MAX) }
      : {}),
    ...(extras.restart ? { restart: extras.restart } : {}),
    ...(extras.logFile !== undefined ? { logFile: extras.logFile } : {}),
    ...(extras.message !== undefined
      ? { message: fitToLimit(extras.message, UPDATE_ERROR_MAX) }
      : {}),
    exitCode: OUTCOME_EXIT_CODES[outcome],
  };
}

function scriptFailedReport(
  installedVia: InstallOrigin,
  currentVersion: string,
  exitCode: number,
  target?: ResolvedDownload
): UpgradeReport {
  return report('failed', installedVia, currentVersion, {
    ...(target ? { target } : {}),
    message: `Install script exited with code ${exitCode}.`,
  });
}

function caughtFailure(
  installedVia: InstallOrigin,
  currentVersion: string,
  error: unknown
): UpgradeReport {
  return report('failed', installedVia, currentVersion, {
    message: error instanceof Error ? error.message : String(error),
  });
}

const UNKNOWN_INSTALLED_VIA: InstallOrigin = {
  manager: 'unknown',
  channel: 'stable',
  executable: '',
};

/** After the pointer moves: emit `restart`, decide the outcome, and run the effect for `'scheduled'`. */
async function withRestart(
  installedVia: InstallOrigin,
  currentVersion: string,
  target: ResolvedDownload | undefined,
  wantsRestart: boolean,
  d: UpgradeServiceDeps,
  emit: EmitUpgradeEvent
): Promise<UpgradeReport> {
  emit(stageEvent('restart'));
  const state = await readLiveState(d.readState, d.isAlive);
  const launch: HubLaunchMode | null = state ? hubLaunchMode(state) : null;
  const decision = decideRestart({ launch, platform: d.platform, restart: wantsRestart });

  // The install already succeeded and the pointer already moved: a restart
  // that fails to come back (a slow detached stop, a supervisor refusal) is
  // reported as a manual restart to run by hand, not as a failed upgrade.
  let restart = decision.restart;
  let restartFailure: string | undefined;
  if (decision.restart === 'scheduled' && state && launch) {
    try {
      await d.restartHub({ state, launch });
    } catch (error) {
      restart = 'manual';
      const reason = error instanceof Error ? error.message : String(error);
      restartFailure = `Restart failed: ${reason}. Run "mangostudio restart".`;
    }
  }

  // A legacy self-managed root migrates its `current` pointer as part of this
  // same install; re-probe rather than trust a value captured before it ran.
  const executable = d.currentExecutable();
  const versionedNote = executable.pointer === 'versioned' ? executable.note : undefined;
  const message = joinMessages(decision.message, restartFailure, versionedNote);

  return report('upgraded', installedVia, currentVersion, {
    ...(target ? { target } : {}),
    restart,
    ...(message !== undefined ? { message } : {}),
  });
}

/**
 * POSIX: run the package manager's own command directly, relaying its
 * output, then go through the same restart stage as a self-managed install —
 * the manager replaced the file on disk, but a hub already running keeps
 * serving the old inode until something bounces it. Windows: see
 * `runWindowsDelegate`.
 */
async function runPosixDelegate(
  plan: Extract<UpgradePlan, { kind: 'delegate' }>,
  installedVia: InstallOrigin,
  request: UpgradeRunRequest,
  d: UpgradeServiceDeps,
  emit: EmitUpgradeEvent
): Promise<UpgradeReport> {
  emit(stageEvent('install'));
  const run = d.runScript(plan.argv, { env: delegateEnv(d.env) });
  const exitCode = await relayLines(run, emit);
  if (exitCode !== 0) return scriptFailedReport(installedVia, d.getVersion(), exitCode);
  return await withRestart(installedVia, d.getVersion(), undefined, request.restart, d, emit);
}

/** A hub running in a process other than the one handling this upgrade. */
interface LiveHub {
  readonly state: ServerState;
  readonly launch: HubLaunchMode;
}

/**
 * The command that brings a stopped hub back the way it was started, run by
 * the waiter through the launcher on PATH once the manager has replaced the
 * binary. `restart` starts the installed unit when nothing is live; a
 * detached instance needs `serve -d` with its own target, since `restart`
 * has no state file to read by then.
 */
function comebackArgv(hub: LiveHub): readonly string[] {
  if (hub.launch === 'service') return ['mangostudio', 'restart'];
  return ['mangostudio', 'serve', '-d', `${hub.state.host}:${hub.state.port}`];
}

function windowsDelegateMessage(
  hub: LiveHub | null,
  wantsRestart: boolean,
  logFile: string
): string {
  if (!hub) {
    return 'The package manager runs after this process exits; check the log and run "mangostudio --version" in a minute.';
  }
  const stopped = `Stopped MangoStudio (PID ${hub.state.pid}) so the package manager can replace the binary once this process exits`;
  if (wantsRestart) {
    return `${stopped}; it starts the hub again once the manager step finishes. Check ${logFile} and "mangostudio status" in a minute.`;
  }
  return `${stopped}. Bring it back with "${comebackArgv(hub).join(' ')}" once ${logFile} shows the manager finished.`;
}

/**
 * Windows: the manager that owns the binary cannot replace a file a running
 * process holds open, so it runs detached, after this process exits. A hub
 * running in a different process from the one handling this upgrade (the
 * CLI-triggered case — the machine route refuses delegate plans) would never
 * exit on its own, so it is stopped here first: the waiter's wait on its pid
 * is then a safety net, and the waiter's `afterSuccess` step is what brings it back.
 * A foreground hub belongs to the terminal that owns it, the same refusal
 * `mangostudio restart` makes.
 */
async function runWindowsDelegate(
  plan: Extract<UpgradePlan, { kind: 'delegate' }>,
  installedVia: InstallOrigin,
  request: UpgradeRunRequest,
  d: UpgradeServiceDeps,
  emit: EmitUpgradeEvent
): Promise<UpgradeReport> {
  emit(stageEvent('install'));
  const state = await readLiveState(d.readState, d.isAlive);
  const hub: LiveHub | null =
    state && state.pid !== d.pid ? { state, launch: hubLaunchMode(state) } : null;
  if (hub?.launch === 'foreground') {
    return caughtFailure(
      installedVia,
      d.getVersion(),
      new Error(
        `MangoStudio is running in the foreground (PID ${hub.state.pid}) and holds mangostudio.exe open. Press Ctrl-C in its terminal and run "mangostudio upgrade" again.`
      )
    );
  }
  if (hub) {
    try {
      await d.stopHub(hub);
    } catch (error) {
      return caughtFailure(installedVia, d.getVersion(), error);
    }
  }

  const logFile = getUpgradeLogPath(d.now());
  const afterSuccess = hub && request.restart ? comebackArgv(hub) : undefined;
  d.spawnDetachedWaiter({
    argv: plan.argv,
    waitForPid: hub ? [hub.state.pid, d.pid] : d.pid,
    logFile,
    env: delegateEnv(d.env),
    ...(afterSuccess ? { afterSuccess } : {}),
  });
  return report('upgraded', installedVia, d.getVersion(), {
    restart: !hub ? 'not-running' : request.restart ? 'scheduled' : 'manual',
    logFile,
    message: windowsDelegateMessage(hub, request.restart, logFile),
  });
}

async function runDelegate(
  plan: Extract<UpgradePlan, { kind: 'delegate' }>,
  installedVia: InstallOrigin,
  request: UpgradeRunRequest,
  d: UpgradeServiceDeps,
  emit: EmitUpgradeEvent
): Promise<UpgradeReport> {
  // Nothing to preview: a delegate plan resolves its own version (a dist-tag,
  // or the package manager's own "latest") at run time, not through this
  // engine, so a --check here can only name the command instead of running it.
  if (request.checkOnly) {
    return report('refused', installedVia, d.getVersion(), {
      reason: 'package-manager',
      command: plan.command,
    });
  }
  if (d.platform === 'win32') return await runWindowsDelegate(plan, installedVia, request, d, emit);
  return await runPosixDelegate(plan, installedVia, request, d, emit);
}

interface InstallScriptRun {
  readonly installedVia: InstallOrigin;
  /** Scratch directory name under the dist root — contained by `resolveContainedStagingDir`. */
  readonly stagingName: string;
  /** Emitted before the staging directory exists, so a failed `mkdir` still names what was being attempted. */
  readonly firstStage: UpgradeStreamEvent;
  /** Reported on the outcome; a rollback has no resolved target to name. */
  readonly target?: ResolvedDownload;
  readonly restart: boolean;
  /**
   * Everything the flow does inside its own staging directory before the
   * script runs — the install path downloads and verifies here — returning the
   * flags that tell the script which job to do.
   */
  readonly buildFlags: (stagingDir: string, kind: InstallerKind) => Promise<readonly string[]>;
}

/**
 * Stage, run and clean up one invocation of the embedded install script. The
 * install and rollback paths differ only in which flags they hand it and what
 * they do inside the staging directory first; containment, cleanup, the script
 * env and the exit-code convention are stated here once.
 */
async function runInstallScript(
  input: InstallScriptRun,
  d: UpgradeServiceDeps,
  emit: EmitUpgradeEvent
): Promise<UpgradeReport> {
  const { installedVia, target } = input;
  if (installedVia.distRoot === undefined) {
    throw new Error(
      `A self-managed install has no distRoot on installedVia: ${installedVia.executable}`
    );
  }
  const stagingDir = resolveContainedStagingDir(
    d.platform,
    installedVia.distRoot,
    input.stagingName
  );
  const kind: InstallerKind = d.platform === 'win32' ? 'ps1' : 'sh';

  try {
    emit(input.firstStage);
    await d.mkdir(stagingDir);
    const flags = await input.buildFlags(stagingDir, kind);
    const scriptPath = await d.writeTempScript(stagingDir, kind);
    const run = d.runScript(installerArgv(kind, scriptPath, flags, d.which), {
      env: buildScriptEnv(d.env, installedVia),
    });
    const exitCode = await relayLines(run, emit);
    if (exitCode !== 0) return scriptFailedReport(installedVia, d.getVersion(), exitCode, target);

    return await withRestart(installedVia, d.getVersion(), target, input.restart, d, emit);
  } finally {
    await d.removeDir(stagingDir);
  }
}

async function runSelf(
  installedVia: InstallOrigin,
  channel: UpdateChannel,
  request: UpgradeRunRequest,
  d: UpgradeServiceDeps,
  emit: EmitUpgradeEvent
): Promise<UpgradeReport> {
  const buildInfo = d.getBuildInfo();
  const context: UpgradeTargetContext = {
    platformId: d.platformId,
    currentVersion: d.getVersion(),
    // Omitted rather than sent as the 'unknown' sentinel: isAlreadyCurrent's
    // sha-prefix compare would otherwise run against a string that can
    // never match a real sha, always concluding "different" for a canary
    // build with no BUILD_GIT_SHA stamped in — falling back to its version
    // check instead, the same as if this build genuinely had no sha to offer.
    ...(isKnownBuildSha(buildInfo) ? { buildSha: buildInfo.gitSha } : {}),
  };
  const resolved = await d.resolveUpgradeTarget(
    { channel, version: request.version, sha: request.sha },
    context
  );
  if ('reason' in resolved) {
    return report('refused', installedVia, d.getVersion(), {
      reason: resolved.reason,
      message: resolved.message,
    });
  }

  if (
    isAlreadyCurrent(resolved, {
      currentVersion: d.getVersion(),
      buildSha: context.buildSha,
      pinned: request.version !== undefined,
    })
  ) {
    return report('already-current', installedVia, d.getVersion(), { target: resolved });
  }
  if (request.checkOnly) {
    return report('available', installedVia, d.getVersion(), { target: resolved });
  }

  return await runInstallScript(
    {
      installedVia,
      stagingName: `.staging-${resolved.version}-${d.pid}`,
      firstStage: stageEvent('download', resolved.assetName),
      target: resolved,
      restart: request.restart,
      buildFlags: async (stagingDir, kind) => {
        const downloaded = await d.downloadVerified(resolved, stagingDir);
        emit(stageEvent('verify', downloaded.verification));
        emit(stageEvent('install'));
        return selfInstallFlags(kind, downloaded.path, resolved.version);
      },
    },
    d,
    emit
  );
}

/**
 * Runs `body`, catching any throw into a `failed` report rather than letting
 * it reject — a network error or a spawn failure reports the same way a
 * script that ran and exited non-zero does. `installedViaRef` is read at
 * catch time so a failure reports whatever the flow had already resolved
 * (the real origin, once known) instead of a placeholder.
 */
async function neverRejects(
  installedViaRef: { current: InstallOrigin },
  currentVersion: string,
  body: () => Promise<UpgradeReport>
): Promise<UpgradeReport> {
  try {
    return await body();
  } catch (error) {
    return caughtFailure(installedViaRef.current, currentVersion, error);
  }
}

async function runInner(
  request: UpgradeRunRequest,
  emit: EmitUpgradeEvent,
  d: UpgradeServiceDeps,
  installedViaRef: { current: InstallOrigin }
): Promise<UpgradeReport> {
  emit(stageEvent('resolve'));
  const { installedVia, channel, plan } = resolveInstallStatus(
    d.probe(),
    d.configuredChannel(),
    d.getVersion(),
    { channel: request.channel, version: request.version, sha: request.sha }
  );
  installedViaRef.current = installedVia;

  if (plan.kind === 'refused') {
    return report('refused', installedVia, d.getVersion(), {
      reason: plan.reason,
      command: plan.command,
      message: plan.message,
    });
  }
  if (plan.kind === 'delegate') return await runDelegate(plan, installedVia, request, d, emit);
  return await runSelf(installedVia, channel, request, d, emit);
}

async function rollbackInner(
  emit: EmitUpgradeEvent,
  d: UpgradeServiceDeps,
  installedViaRef: { current: InstallOrigin },
  restart: boolean
): Promise<UpgradeReport> {
  emit(stageEvent('resolve'));
  const { installedVia, plan } = resolveInstallStatus(
    d.probe(),
    d.configuredChannel(),
    d.getVersion()
  );
  installedViaRef.current = installedVia;

  if (plan.kind !== 'self') {
    const reason = plan.kind === 'refused' ? plan.reason : 'package-manager';
    return report('refused', installedVia, d.getVersion(), {
      reason,
      command: plan.command,
      message: 'Rollback only applies to a self-managed install.',
    });
  }

  const previousVersion = installedVia.record?.previousVersion;
  if (!previousVersion) {
    // Neither a package-manager reason nor a plan command applies here —
    // both fields are optional, and inventing one would misdirect the CLI's
    // "Run: <command>" line toward something that does not fix this.
    return report('refused', installedVia, d.getVersion(), {
      message: 'No previous version recorded to roll back to.',
    });
  }
  return await runInstallScript(
    {
      installedVia,
      stagingName: `.rollback-${previousVersion}-${d.pid}`,
      firstStage: stageEvent('install'),
      restart,
      buildFlags: (_stagingDir, kind) => Promise.resolve(useVersionFlags(kind, previousVersion)),
    },
    d,
    emit
  );
}

/**
 * Real `stopHub` effect: a service-managed hub is stopped through its
 * supervisor and then waited out — `Stop-ScheduledTask` returns before the
 * process is gone, and the caller needs the pid gone, not the request
 * accepted; a detached one is signalled and waited out the way `stop` does.
 */
async function defaultStopHub(input: { state: ServerState; launch: HubLaunchMode }): Promise<void> {
  const controller = createProcessController();
  const timeoutMessage = `MangoStudio (PID ${input.state.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s.`;
  if (input.launch === 'service') {
    await createHubServiceManager().stop();
    const stopped = await waitForExit(controller, input.state.pid, {
      timeoutMs: STOP_TIMEOUT_MS,
      intervalMs: STOP_POLL_INTERVAL_MS,
      now: Date.now,
      sleep,
    });
    if (!stopped) throw new Error(timeoutMessage);
    return;
  }
  await stopPidOrThrow({ controller, now: Date.now, sleep }, input.state.pid, timeoutMessage);
}

/**
 * Real `restartHub` effect: service-managed bounces through the supervisor,
 * detached stops the old pid and spawns a successor through the installer's
 * `current` pointer when it resolves to one. Fire-and-forget by design — it
 * does not wait for the successor to become healthy, matching the report's
 * own `'scheduled'` wording rather than a confirmed restart.
 */
async function defaultRestartHub(input: {
  state: ServerState;
  launch: HubLaunchMode;
}): Promise<void> {
  if (input.launch === 'service') {
    await createHubServiceManager().restart();
    return;
  }
  const controller = createProcessController();
  await stopPidOrThrow(
    { controller, now: Date.now, sleep },
    input.state.pid,
    `MangoStudio (PID ${input.state.pid}) did not stop within 10s.`
  );
  await spawnDetached(
    input.state.port,
    input.state.host,
    {},
    { waitForPid: input.state.pid, ...restartExecutableOptions(currentHubExecutable()) }
  );
}

const safeFetchDeps: SafeFetchDeps = { fetch };

function resolveDeps(deps: Partial<UpgradeServiceDeps>): UpgradeServiceDeps {
  return {
    probe: deps.probe ?? (() => currentInstallOriginProbe()),
    configuredChannel: deps.configuredChannel ?? (() => getConfig().updates.channel),
    resolveUpgradeTarget:
      deps.resolveUpgradeTarget ??
      ((request, context) => resolveUpgradeTargetImpl(request, context, safeFetchDeps)),
    downloadVerified:
      deps.downloadVerified ??
      ((resolved, destinationDir) => downloadVerifiedImpl(resolved, destinationDir, safeFetchDeps)),
    runScript: deps.runScript ?? runScriptImpl,
    writeTempScript: deps.writeTempScript ?? writeTempScriptReal,
    which: deps.which ?? ((name) => Bun.which(name)),
    mkdir: deps.mkdir ?? (async (path) => void (await mkdir(path, { recursive: true }))),
    removeDir:
      deps.removeDir ?? (async (path) => void (await rm(path, { recursive: true, force: true }))),
    spawnDetachedWaiter: deps.spawnDetachedWaiter ?? spawnDetachedWaiter,
    stopHub: deps.stopHub ?? defaultStopHub,
    restartHub: deps.restartHub ?? defaultRestartHub,
    currentExecutable: deps.currentExecutable ?? (() => currentHubExecutable()),
    readState: deps.readState ?? readState,
    isAlive: deps.isAlive ?? createProcessController().isAlive,
    now: deps.now ?? Date.now,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    getVersion: deps.getVersion ?? getVersion,
    getBuildInfo: deps.getBuildInfo ?? getBuildInfo,
    platformId: deps.platformId ?? resolveBuildPlatformId(),
    pid: deps.pid ?? process.pid,
  };
}

/**
 * A second `run()`/`rollback()` while one is still live on this engine
 * instance would stage into the same `.staging-<version>-<pid>` directory
 * (keyed off this process's own pid) as the first, racing its download and
 * deleting its script out from under it once either one's `finally` cleans
 * up. This is the last line of defence: `machine-service.ts` already refuses
 * a second `POST /machine/upgrade` while one is streaming, but the CLI calls
 * `run()`/`rollback()` directly, and a client that disconnects mid-stream
 * frees the machine-service lock while the engine call above is still
 * running in the background.
 */
function inProgressReport(currentVersion: string): UpgradeReport {
  return report('refused', UNKNOWN_INSTALLED_VIA, currentVersion, {
    reason: 'in-progress',
    command: 'mangostudio status',
    message: 'Another upgrade is already running from this process.',
  });
}

/** Build the engine. // Usage: createUpgradeService().run({ restart: true }, emit) */
export function createUpgradeService(deps: Partial<UpgradeServiceDeps> = {}): UpgradeService {
  const d = resolveDeps(deps);
  let running = false;

  async function guardedRun(body: () => Promise<UpgradeReport>): Promise<UpgradeReport> {
    if (running) return inProgressReport(d.getVersion());
    running = true;
    try {
      return await body();
    } finally {
      running = false;
    }
  }

  return {
    run: (request, emit) => {
      const installedViaRef = { current: UNKNOWN_INSTALLED_VIA };
      return guardedRun(() =>
        neverRejects(installedViaRef, d.getVersion(), () =>
          runInner(request, emit, d, installedViaRef)
        )
      );
    },
    rollback: (emit, options = {}) => {
      const installedViaRef = { current: UNKNOWN_INSTALLED_VIA };
      return guardedRun(() =>
        neverRejects(installedViaRef, d.getVersion(), () =>
          rollbackInner(emit, d, installedViaRef, options.restart ?? true)
        )
      );
    },
  };
}
