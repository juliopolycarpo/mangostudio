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

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { HubLaunchMode } from '@mangostudio/shared/machine';
import {
  UPDATE_ERROR_MAX,
  UPDATE_VERSION_MAX,
  UPGRADE_COMMAND_MAX,
  UPGRADE_OUTPUT_LINE_MAX,
  type UpdateChannel,
  type UpgradeReport,
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
  WINDOWS_SYSTEM_ENV_KEYS,
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
import { isStateLive, readState, type ServerState } from '../../../lib/server-state';
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
import {
  embeddedInstaller,
  embeddedInstallerFileName,
  type InstallerKind,
} from '../infrastructure/embedded-installers';
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

/**
 * Env keys the embedded install script needs, deduped against
 * `WINDOWS_SYSTEM_ENV_KEYS` (detach.ts) rather than repeating the ones this
 * list already names (LOCALAPPDATA, SystemRoot). Without the rest of that
 * Windows block, install.ps1's `Get-Platform` cannot classify the host
 * architecture (PROCESSOR_ARCHITECTURE/PROCESSOR_ARCHITEW6432) and, even once
 * it does, PowerShell 5.1's `& $exe '--version'` smoke check needs PATHEXT to
 * resolve the target as executable. `runScript` (run-script.ts) replaces
 * rather than merges the child's environment, so a missing key here is
 * simply gone for the whole run.
 */
const SCRIPT_ENV_PASSTHROUGH: readonly string[] = Array.from(
  new Set<string>([
    'PATH',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    // install.sh's mktemp -d reads TMPDIR (POSIX); not in the brief's list, but
    // without it a HOME override in a test or a sandboxed run cannot steer
    // where the script stages its own extraction.
    'TMPDIR',
    ...WINDOWS_SYSTEM_ENV_KEYS,
  ])
);

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
    ...(resolved.sourceSha !== undefined ? { sourceSha: fitToLimit(resolved.sourceSha, 64) } : {}),
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
 * Env the embedded install script receives: the passthrough set plus what
 * tells it this is an upgrade. Also used by `prune-retry.ts` for the
 * `-Prune` retry on start — `MANGOSTUDIO_INSTALL_ORIGIN` is harmless there
 * since `-Prune`/`--prune` never reads it, and the install dir/bin dir
 * overrides are exactly what a prune needs to find the right root.
 */
export function buildScriptEnv(
  env: NodeJS.ProcessEnv,
  installedVia: InstallOrigin
): Record<string, string> {
  const scriptEnv: Record<string, string> = {};
  for (const key of SCRIPT_ENV_PASSTHROUGH) {
    const value = env[key];
    if (value !== undefined) scriptEnv[key] = value;
  }
  scriptEnv.MANGOSTUDIO_INSTALL_ORIGIN = 'upgrade';
  if (installedVia.distRoot !== undefined)
    scriptEnv.MANGOSTUDIO_INSTALL_DIR = installedVia.distRoot;
  if (installedVia.record?.binDir !== undefined) {
    scriptEnv.MANGOSTUDIO_BIN_DIR = installedVia.record.binDir;
  }
  return scriptEnv;
}

export function powershellInterpreter(which: (name: string) => string | null): string {
  return which('pwsh') !== null ? 'pwsh' : 'powershell.exe';
}

/**
 * argv for the embedded script's install path, one flag set per shell.
 * `--version`/`-Version` is passed for every kind, not just `npm-tarball`: a
 * canary archive's file name only carries the bare `<major>.<minor>.<patch>-
 * canary`, but `target.version` (resolved from the canary manifest) carries
 * the full `<version>.<sha7>` the binary reports — without it install.sh
 * falls back to deriving the version from the file name and the post-install
 * smoke check compares that truncated string against `--version`, failing
 * every canary self-upgrade.
 */
function selfInstallArgv(
  kind: InstallerKind,
  scriptPath: string,
  archivePath: string,
  target: ResolvedDownload,
  which: (name: string) => string | null
): string[] {
  if (kind === 'sh') {
    return ['bash', scriptPath, '--local', archivePath, '--version', target.version];
  }
  return [
    powershellInterpreter(which),
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Local',
    archivePath,
    '-Version',
    target.version,
  ];
}

/** argv for the embedded script's `--use`/`-Use` path — no download, just a pointer swap. */
function useVersionArgv(
  kind: InstallerKind,
  scriptPath: string,
  version: string,
  which: (name: string) => string | null
): string[] {
  if (kind === 'sh') return ['bash', scriptPath, '--use', version];
  return [
    powershellInterpreter(which),
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Use',
    version,
  ];
}

function scriptFailedReport(
  installedVia: InstallOrigin,
  currentVersion: string,
  exitCode: number,
  target?: ResolvedDownload
): UpgradeReport {
  return {
    outcome: 'failed',
    installedVia: fitInstalledVia(installedVia),
    currentVersion,
    ...(target ? { target: toWireTarget(target) } : {}),
    exitCode: 2,
    message: fitToLimit(`Install script exited with code ${exitCode}.`, UPDATE_ERROR_MAX),
  };
}

function caughtFailure(
  installedVia: InstallOrigin,
  currentVersion: string,
  error: unknown
): UpgradeReport {
  const message = error instanceof Error ? error.message : String(error);
  return {
    outcome: 'failed',
    installedVia: fitInstalledVia(installedVia),
    currentVersion,
    exitCode: 2,
    message: fitToLimit(message, UPDATE_ERROR_MAX),
  };
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
  const rawState = await d.readState();
  // A state file surviving a SIGKILL (or any crash that skips cleanup) still
  // names a pid, but that pid can already belong to an unrelated, recycled
  // process — isStateLive is the only thing distinguishing "the hub owns
  // this file" from "a stale file with no hub behind it".
  const state = rawState && isStateLive(rawState, d.isAlive) ? rawState : null;
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

  return {
    outcome: 'upgraded',
    installedVia: fitInstalledVia(installedVia),
    currentVersion,
    ...(target ? { target: toWireTarget(target) } : {}),
    restart,
    ...(message ? { message: fitToLimit(message, UPDATE_ERROR_MAX) } : {}),
    exitCode: 0,
  };
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
    return `${stopped}; it starts the hub again when the manager succeeds. Check ${logFile} and "mangostudio status" in a minute.`;
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
  const rawState = await d.readState();
  const state = rawState && isStateLive(rawState, d.isAlive) ? rawState : null;
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
  return {
    outcome: 'upgraded',
    installedVia: fitInstalledVia(installedVia),
    currentVersion: d.getVersion(),
    restart: !hub ? 'not-running' : request.restart ? 'scheduled' : 'manual',
    logFile,
    message: fitToLimit(windowsDelegateMessage(hub, request.restart, logFile), UPDATE_ERROR_MAX),
    exitCode: 0,
  };
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
    return {
      outcome: 'refused',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      reason: 'package-manager',
      command: fitToLimit(plan.command, UPGRADE_COMMAND_MAX),
      exitCode: 1,
    };
  }
  if (d.platform === 'win32') return await runWindowsDelegate(plan, installedVia, request, d, emit);
  return await runPosixDelegate(plan, installedVia, request, d, emit);
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
    return {
      outcome: 'refused',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      reason: resolved.reason,
      message: fitToLimit(resolved.message, UPDATE_ERROR_MAX),
      exitCode: 1,
    };
  }

  if (
    isAlreadyCurrent(resolved, {
      currentVersion: d.getVersion(),
      buildSha: context.buildSha,
      pinned: request.version !== undefined,
    })
  ) {
    return {
      outcome: 'already-current',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      target: toWireTarget(resolved),
      exitCode: 0,
    };
  }
  if (request.checkOnly) {
    return {
      outcome: 'available',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      target: toWireTarget(resolved),
      exitCode: 0,
    };
  }

  if (installedVia.distRoot === undefined) {
    throw new Error(
      `A self-managed install has no distRoot on installedVia: ${installedVia.executable}`
    );
  }
  const stagingDir = resolveContainedStagingDir(
    d.platform,
    installedVia.distRoot,
    `.staging-${resolved.version}-${d.pid}`
  );

  try {
    emit(stageEvent('download', resolved.assetName));
    await d.mkdir(stagingDir);
    const downloaded = await d.downloadVerified(resolved, stagingDir);
    emit(stageEvent('verify', downloaded.verification));

    emit(stageEvent('install'));
    const kind: InstallerKind = d.platform === 'win32' ? 'ps1' : 'sh';
    const scriptPath = await d.writeTempScript(stagingDir, kind);
    const argv = selfInstallArgv(kind, scriptPath, downloaded.path, resolved, d.which);
    const run = d.runScript(argv, { env: buildScriptEnv(d.env, installedVia) });
    const exitCode = await relayLines(run, emit);
    if (exitCode !== 0) return scriptFailedReport(installedVia, d.getVersion(), exitCode, resolved);

    return await withRestart(installedVia, d.getVersion(), resolved, request.restart, d, emit);
  } finally {
    await d.removeDir(stagingDir);
  }
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
    return {
      outcome: 'refused',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      reason: plan.reason,
      command: fitToLimit(plan.command, UPGRADE_COMMAND_MAX),
      message: fitToLimit(plan.message, UPDATE_ERROR_MAX),
      exitCode: 1,
    };
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
    return {
      outcome: 'refused',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      reason,
      command: fitToLimit(plan.command, UPGRADE_COMMAND_MAX),
      message: fitToLimit('Rollback only applies to a self-managed install.', UPDATE_ERROR_MAX),
      exitCode: 1,
    };
  }

  const previousVersion = installedVia.record?.previousVersion;
  if (!previousVersion) {
    // Neither a package-manager reason nor a plan command applies here —
    // both fields are optional, and inventing one would misdirect the CLI's
    // "Run: <command>" line toward something that does not fix this.
    return {
      outcome: 'refused',
      installedVia: fitInstalledVia(installedVia),
      currentVersion: d.getVersion(),
      message: fitToLimit('No previous version recorded to roll back to.', UPDATE_ERROR_MAX),
      exitCode: 1,
    };
  }
  if (installedVia.distRoot === undefined) {
    throw new Error(
      `A self-managed install has no distRoot on installedVia: ${installedVia.executable}`
    );
  }

  const stagingDir = resolveContainedStagingDir(
    d.platform,
    installedVia.distRoot,
    `.rollback-${previousVersion}-${d.pid}`
  );
  try {
    emit(stageEvent('install'));
    await d.mkdir(stagingDir);
    const kind: InstallerKind = d.platform === 'win32' ? 'ps1' : 'sh';
    const scriptPath = await d.writeTempScript(stagingDir, kind);
    const argv = useVersionArgv(kind, scriptPath, previousVersion, d.which);
    const run = d.runScript(argv, { env: buildScriptEnv(d.env, installedVia) });
    const exitCode = await relayLines(run, emit);
    if (exitCode !== 0) return scriptFailedReport(installedVia, d.getVersion(), exitCode);

    return await withRestart(installedVia, d.getVersion(), undefined, restart, d, emit);
  } finally {
    await d.removeDir(stagingDir);
  }
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

export async function writeTempScriptReal(directory: string, kind: InstallerKind): Promise<string> {
  const path = joinPath(process.platform, directory, embeddedInstallerFileName(kind));
  await writeFile(path, embeddedInstaller(kind), { mode: kind === 'sh' ? 0o755 : 0o644 });
  return path;
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
  return {
    outcome: 'refused',
    installedVia: fitInstalledVia(UNKNOWN_INSTALLED_VIA),
    currentVersion,
    reason: 'in-progress',
    command: 'mangostudio status',
    message: fitToLimit('Another upgrade is already running from this process.', UPDATE_ERROR_MAX),
    exitCode: 1,
  };
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
