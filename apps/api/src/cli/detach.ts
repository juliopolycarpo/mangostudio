/**
 * Start the server as a detached background process by re-executing this same
 * binary with the hidden `__serve` subcommand, redirecting its output to a log
 * file, and confirming it actually came up before reporting success.
 */

import { closeSync, openSync } from 'node:fs';
import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import { RUNTIME_CONFIG_ENV_KEYS } from '../lib/config';
import { ensureRuntimeDirs, getServerLogPath } from '../lib/mango-paths';
import { isStandaloneExecutable } from '../lib/runtime-paths';
import { readState } from '../lib/server-state';
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
 * Runtime env keys forwarded to detached child processes.
 * Connector secrets and other injectable credentials are excluded; only the
 * runtime configuration (mirrors config.ts `ENV_KEY_MAP`) plus the system and
 * networking variables the server actually needs to run are forwarded.
 */
const DETACH_ENV_ALLOWLIST = new Set<string>([
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
]);

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
  const env: Record<string, string> = {};

  for (const key of DETACH_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

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
      cmd: buildServeCommand(host, port),
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

/** In a compiled binary, re-exec it directly; in dev, run the entry via bun. */
function buildServeCommand(host: string, port: number): string[] {
  const target = `${host}:${port}`;
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
