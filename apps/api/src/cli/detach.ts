/**
 * Start the server as a detached background process by re-executing this same
 * binary with the hidden `__serve` subcommand, redirecting its output to a log
 * file, and confirming it actually came up before reporting success.
 */

import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import { RUNTIME_CONFIG_ENV_KEYS } from '../lib/config';
import { ensureRuntimeDirs, getServerLogPath } from '../lib/mango-paths';
import { isStandaloneExecutable } from '../lib/runtime-paths';
import { readState } from '../lib/server-state';
import type { HubExecutable } from '../modules/machine/domain/hub-executable';
import { CliError } from './errors';
import { confirmsHealthy } from './health';
import { createProcessController, type ProcessController } from './process-control';
import { RESTART_WAIT_PID_ENV, RESTART_WAIT_TIMEOUT_MS } from './restart-handshake';
import { sleep } from './sleep';

export interface DetachResult {
  pid: number;
  port: number;
  logFile: string;
}

export interface DetachOptions {
  /**
   * A pid the child waits on before it binds. Set by `restart`, whose child
   * is spawned while the old server is still shutting down.
   */
  waitForPid?: number;
  /**
   * Run this argv instead of re-execing the current binary. A restart after
   * an installer upgrade passes the `current` pointer here, so the successor
   * launches the new version rather than the build that is restarting it.
   */
  executable?: readonly string[];
}

/**
 * Spawn options that route a restart through the installer's `current`
 * pointer, when this process resolves to it. Every other pointer kind keeps
 * today's behaviour (re-exec this binary), so an upgrade never changes what a
 * non-installer restart does.
 * // Usage: spawnDetached(port, host, {}, { waitForPid, ...restartExecutableOptions(currentHubExecutable()) })
 */
export function restartExecutableOptions(
  executable: Pick<HubExecutable, 'pointer' | 'argv'>
): Pick<DetachOptions, 'executable'> {
  return executable.pointer === 'current' ? { executable: executable.argv } : {};
}

export interface DetachDeps {
  controller: ProcessController;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Spawn the detached child writing to logFile and return its pid. */
  spawn: (port: number, host: string, logFile: string, options: DetachOptions) => number;
  readState: typeof readState;
  confirmsHealthy: typeof confirmsHealthy;
}

const START_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

/** Spawn a detached server and resolve once it is healthy. // Usage: await spawnDetached(3001, 'localhost') */
export async function spawnDetached(
  port: number,
  host: string,
  deps: Partial<DetachDeps> = {},
  options: DetachOptions = {}
): Promise<DetachResult> {
  const d = resolveDeps(deps);
  await ensureRuntimeDirs();

  const logFile = getServerLogPath(d.now());
  const childPid = d.spawn(port, host, logFile, options);

  const budget = START_TIMEOUT_MS + (options.waitForPid ? RESTART_WAIT_TIMEOUT_MS : 0);
  await confirmStarted({ pid: childPid, port, host, logFile }, d, budget);
  return { pid: childPid, port, logFile };
}

interface PendingChild {
  pid: number;
  port: number;
  host: string;
  logFile: string;
}

/**
 * Poll until the child is healthy, or fail fast if it dies or times out. A bind
 * to one explicit LAN address cannot be probed over loopback, so there the
 * state file naming this pid is the readiness signal — see `confirmsHealthy`.
 */
async function confirmStarted(
  child: PendingChild,
  d: DetachDeps,
  timeoutMs: number
): Promise<void> {
  const deadline = d.now() + timeoutMs;

  while (d.now() < deadline) {
    if (!d.controller.isAlive(child.pid)) {
      throw new CliError(`Server failed to start. See logs: ${child.logFile}`);
    }
    const state = await d.readState();
    if (state?.pid === child.pid && (await d.confirmsHealthy(child.host, child.port))) {
      return;
    }
    await d.sleep(POLL_INTERVAL_MS);
  }

  throw new CliError(
    `Server did not become healthy within ${timeoutMs / 1000}s. See logs: ${child.logFile}`
  );
}

/**
 * Windows system variables a spawned child needs to resolve executables
 * (COMSPEC/PATHEXT), locate its data directories, and detect host
 * architecture (PROCESSOR_ARCHITECTURE/PROCESSOR_ARCHITEW6432 — set by a
 * 32-bit process running under WOW64). Shared by `DETACH_ENV_ALLOWLIST`
 * below and `installer-invocation.ts`'s `SCRIPT_ENV_PASSTHROUGH` (the env the
 * embedded install script runs with), so a key added for one reaches the
 * other instead of drifting between two copied lists.
 */
export const WINDOWS_SYSTEM_ENV_KEYS: readonly string[] = [
  'SystemRoot',
  'windir',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
];

/**
 * Runtime env keys forwarded to detached child processes.
 * Connector secrets and other injectable credentials are excluded; only the
 * runtime configuration (mirrors config.ts `ENV_KEY_MAP`) plus the system and
 * networking variables the server actually needs to run are forwarded.
 */
export const DETACH_ENV_ALLOWLIST = new Set<string>([
  // Runtime configuration — sourced from config.ts so a new ENV_KEY_MAP key
  // reaches detached children without editing two lists.
  ...RUNTIME_CONFIG_ENV_KEYS,
  // Runtime vars read directly from process.env (not part of ENV_KEY_MAP).
  'MANGO_LOG_FILE',
  'VERSION',
  'MANGOSTUDIO_DIAGNOSTIC_LOGS',
  // Who launched this hub, so a `serve -d` child still knows how it was
  // installed — detectInstallOrigin reads these, and an upgrade started from
  // the detached child needs the same answer the foreground process had.
  'MANGOSTUDIO_LAUNCHER',
  'MANGOSTUDIO_LAUNCHER_PATH',
  // System and networking essentials. Bun.spawn replaces (not merges) the
  // child's environment, so omitting these would leave the detached server
  // without executable lookup (breaking the shell-exec tool), home-dir
  // resolution, or outbound TLS/proxy reachability to provider APIs.
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'LANG',
  'LC_ALL',
  // allow-node-env: passes the variable through to detached children; it is
  // not a production branch.
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // Windows runtime essentials. Bun.spawn replaces the env, and without these a
  // detached Windows server loses networking/crypto (SystemRoot/windir),
  // executable resolution for the shell tools (COMSPEC/PATHEXT), the standard
  // data directories provider SDKs read, and — without ProgramFiles /
  // ProgramW6432 — wsl-executable.ts's MSI lookup, which falls back to the
  // System32 launcher stub and reintroduces the console-window flash this hub
  // spawns wsl.exe directly to avoid (see wsl-executable.ts).
  ...WINDOWS_SYSTEM_ENV_KEYS,
]);

/**
 * The subset of `source` whose keys are in `allowlist` or start with one of
 * `prefixes`, dropping anything unset. Exported for callers outside this
 * module that need a narrower env than the hub's full one but cannot name
 * every key up front — a package-manager delegate, for instance, needs
 * `npm_config_*`/`HOMEBREW_*` without enumerating every value npm or
 * Homebrew might set.
 * // Usage: pickAllowedEnv(process.env, ['PATH'], ['npm_config_'])
 */
export function pickAllowedEnv(
  source: NodeJS.ProcessEnv,
  allowlist: ReadonlySet<string> | readonly string[],
  prefixes: readonly string[] = []
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (prefixes.length > 0) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) env[key] = value;
    }
  }
  return env;
}

/**
 * Build a minimal env for a detached `__serve` child, forwarding only
 * runtime configuration variables from the parent's environment.
 * // Usage: buildDetachedEnv('localhost', 3001, '/tmp/server.log')
 */
export function buildDetachedEnv(
  host: string,
  port: number,
  logFile: string,
  options: DetachOptions = {}
): Record<string, string> {
  const env = pickAllowedEnv(process.env, DETACH_ENV_ALLOWLIST);

  // Always apply the explicit spawn parameters as overrides.
  env.API_HOST = host;
  env.API_PORT = String(port);
  env.MANGO_LOG_FILE = logFile;
  if (options.waitForPid !== undefined) {
    env[RESTART_WAIT_PID_ENV] = String(options.waitForPid);
  }

  return env;
}

/**
 * Re-exec this binary (or `bun <entry>` in dev) with the hidden __serve
 * command and return its pid, without waiting for it to come up. `restart`
 * from inside the server uses this directly: the child waits for this
 * process to exit, so this process cannot also wait for the child.
 * // Usage: spawnServeChild(3001, 'localhost', logFile, { waitForPid: process.pid })
 */
export function spawnServeChild(
  port: number,
  host: string,
  logFile: string,
  options: DetachOptions
): number {
  const logFd = openSync(logFile, 'a');
  try {
    const proc = Bun.spawn({
      cmd: buildServeCommand(host, port, options.executable),
      env: buildDetachedEnv(host, port, logFile, options),
      detached: true,
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
      ...HIDDEN_WINDOW,
    });
    proc.unref();
    return proc.pid;
  } finally {
    // The child holds its own copy of the descriptor; release ours.
    closeSync(logFd);
  }
}

export interface SpawnDetachedWaiterInput {
  /** The package manager command to run once the wait is over, e.g. `['npm', 'install', '-g', 'mangostudio@latest']`. */
  readonly argv: readonly string[];
  /**
   * The pid(s) to wait on before running the manager. A single pid for the
   * common case; a list when the process invoking the upgrade (the CLI) is
   * not the same process holding `mangostudio.exe` open (a live hub) — the
   * manager cannot replace the file until both have exited.
   */
  readonly waitForPid: number | readonly number[];
  /** Where the manager's combined output is appended. */
  readonly logFile: string;
  /**
   * What to run once the manager step has run — the command that brings a
   * hub the caller stopped for this upgrade back up, through the launcher on
   * PATH (never this process's realpath: scoop's is versioned and changes
   * with the upgrade). Runs unconditionally, not gated on the manager's exit:
   * a hub already stopped for the upgrade needs recovering either way, and a
   * fresh `powershell.exe`'s `$LASTEXITCODE` cannot be trusted to reflect it.
   * Its output goes to the same log.
   */
  readonly afterSuccess?: readonly string[];
  /**
   * The env the PowerShell host (and so the manager and anything it spawns,
   * such as an npm postinstall) runs with. The caller curates it — the
   * upgrade engine hands over the same delegate env the POSIX path uses,
   * never this process's full environment.
   */
  readonly env: Record<string, string>;
}

/** Single-quotes a PowerShell string literal, doubling any embedded quote. */
function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `& 'program' 'arg'… *>> 'log'`: run argv, appending every stream to the log. */
function loggedInvocation(argv: readonly string[], logFile: string): string {
  const [program, ...args] = argv;
  const invocation = ['&', powerShellQuote(program ?? ''), ...args.map(powerShellQuote)].join(' ');
  return `${invocation} *>> ${powerShellQuote(logFile)}`;
}

/**
 * The `-Command` script text a detached waiter runs: wait out one or more
 * pids, invoke the package manager appending its output to the log, and —
 * when an `afterSuccess` step is given — run it unconditionally afterward.
 *
 * The wait has no timeout on purpose: the caller has already confirmed every
 * pid it names is exiting (its own, and a hub it stopped), so giving up early
 * could only start the manager against a file still held open.
 *
 * `afterSuccess` is only ever set once a live hub has already been stopped
 * for this upgrade (see `runWindowsDelegate`), so it is not actually gated on
 * the manager's exit code: a failed or crashed manager still leaves the old
 * binary on disk, and bringing that hub back is the recovery, not a reward
 * for success. Gating it would also be unreliable in practice — a fresh
 * `powershell.exe` starts with `$LASTEXITCODE` as `$null`, `Wait-Process`
 * never touches it, and `npm`/`scoop` on Windows are `.cmd` shims — so
 * `$LASTEXITCODE` cannot be trusted to reflect the manager's own exit.
 * // Usage: buildWaiterCommand({ argv: ['npm', 'install', '-g', 'x'], waitForPid: [123, 456], logFile: 'C:\\log.txt', afterSuccess: ['mangostudio', 'restart'] })
 */
export function buildWaiterCommand(
  input: Pick<SpawnDetachedWaiterInput, 'argv' | 'waitForPid' | 'logFile' | 'afterSuccess'>
): string {
  const ids = Array.isArray(input.waitForPid) ? input.waitForPid.join(', ') : input.waitForPid;
  const steps = [
    `Wait-Process -Id ${ids} -ErrorAction SilentlyContinue`,
    loggedInvocation(input.argv, input.logFile),
  ];
  if (input.afterSuccess) {
    steps.push(loggedInvocation(input.afterSuccess, input.logFile));
  }
  return steps.join('; ');
}

/**
 * PowerShell's `*>>` redirect does not create a missing parent directory, and
 * nothing guarantees the run dir exists before an upgrade that never started
 * a hub in this session (`ensureRuntimeDirs` is otherwise `serve`'s job).
 * // Usage: ensureLogDir('/home/j/.mango/run/upgrade-1.log')
 */
export function ensureLogDir(logFile: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
}

/**
 * Windows-only: spawn a detached PowerShell that waits for this process (and
 * a hub the caller stopped) to exit, then runs a package-manager upgrade,
 * logs its output, and optionally brings the hub back — used when the
 * manager that owns the binary would otherwise try to replace a file a
 * running process still holds open.
 * // Usage: spawnDetachedWaiter({ argv: ['npm', 'install', '-g', 'mangostudio@latest'], waitForPid: process.pid, logFile, env })
 */
export function spawnDetachedWaiter(input: SpawnDetachedWaiterInput): number {
  ensureLogDir(input.logFile);
  const proc = Bun.spawn({
    cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', buildWaiterCommand(input)],
    env: input.env,
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    ...HIDDEN_WINDOW,
  });
  proc.unref();
  return proc.pid;
}

/**
 * In a compiled binary, re-exec it directly; in dev, run the entry via bun.
 * An explicit `executable` (the installer's `current` pointer) wins over
 * either default.
 */
function buildServeCommand(host: string, port: number, executable?: readonly string[]): string[] {
  const target = `${host}:${port}`;
  if (executable && executable.length > 0) {
    return [...executable, '__serve', target];
  }
  if (isStandaloneExecutable()) {
    return [process.execPath, '__serve', target];
  }
  return [process.execPath, Bun.main, '__serve', target];
}

function resolveDeps(deps: Partial<DetachDeps>): DetachDeps {
  return {
    controller: deps.controller ?? createProcessController(),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? sleep,
    spawn: deps.spawn ?? spawnServeChild,
    readState: deps.readState ?? readState,
    confirmsHealthy: deps.confirmsHealthy ?? confirmsHealthy,
  };
}
