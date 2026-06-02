/**
 * Start the server as a detached background process by re-executing this same
 * binary with the hidden `__serve` subcommand, redirecting its output to a log
 * file, and confirming it actually came up before reporting success.
 */

import { closeSync, openSync } from 'node:fs';
import { RUNTIME_CONFIG_ENV_KEYS } from '../lib/config';
import { ensureRuntimeDirs, getServerLogPath } from '../lib/mango-paths';
import { isStandaloneExecutable } from '../lib/runtime-paths';
import { readState } from '../lib/server-state';
import { CliError } from './errors';
import { probeHealth } from './health';
import { createProcessController, type ProcessController } from './process-control';
import { sleep } from './sleep';

export interface DetachResult {
  pid: number;
  port: number;
  logFile: string;
}

export interface DetachDeps {
  controller: ProcessController;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Spawn the detached child writing to logFile and return its pid. */
  spawn: (port: number, host: string, logFile: string) => number;
  readState: typeof readState;
  probeHealth: typeof probeHealth;
}

const START_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

/** Spawn a detached server and resolve once it is healthy. // Usage: await spawnDetached(3001, 'localhost') */
export async function spawnDetached(
  port: number,
  host: string,
  deps: Partial<DetachDeps> = {}
): Promise<DetachResult> {
  const d = resolveDeps(deps);
  await ensureRuntimeDirs();

  const logFile = getServerLogPath(d.now());
  const childPid = d.spawn(port, host, logFile);

  await confirmStarted({ pid: childPid, port, host, logFile }, d);
  return { pid: childPid, port, logFile };
}

interface PendingChild {
  pid: number;
  port: number;
  host: string;
  logFile: string;
}

/** Poll until the child is healthy, or fail fast if it dies or times out. */
async function confirmStarted(child: PendingChild, d: DetachDeps): Promise<void> {
  const deadline = d.now() + START_TIMEOUT_MS;

  while (d.now() < deadline) {
    if (!d.controller.isAlive(child.pid)) {
      throw new CliError(`Server failed to start. See logs: ${child.logFile}`);
    }
    const state = await d.readState();
    if (state?.pid === child.pid && (await d.probeHealth(child.host, child.port))) {
      return;
    }
    await d.sleep(POLL_INTERVAL_MS);
  }

  throw new CliError(
    `Server did not become healthy within ${START_TIMEOUT_MS / 1000}s. See logs: ${child.logFile}`
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
  // executable resolution for the shell tools (COMSPEC/PATHEXT), and the
  // standard data directories provider SDKs read.
  'SystemRoot',
  'windir',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
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
  logFile: string
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

  return env;
}

/** Re-exec this binary (or `bun <entry>` in dev) with the hidden __serve command. */
function realSpawn(port: number, host: string, logFile: string): number {
  const logFd = openSync(logFile, 'a');
  try {
    const proc = Bun.spawn({
      cmd: buildServeCommand(host, port),
      env: buildDetachedEnv(host, port, logFile),
      detached: true,
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
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
    spawn: deps.spawn ?? realSpawn,
    readState: deps.readState ?? readState,
    probeHealth: deps.probeHealth ?? probeHealth,
  };
}
