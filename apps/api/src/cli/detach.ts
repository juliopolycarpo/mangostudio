/**
 * Start the server as a detached background process by re-executing this same
 * binary with the hidden `__serve` subcommand, redirecting its output to a log
 * file, and confirming it actually came up before reporting success.
 */

import { closeSync, openSync } from 'node:fs';
import { ensureRuntimeDirs, getServerLogPath } from '../lib/mango-paths';
import { isStandaloneExecutable } from '../lib/runtime-paths';
import { readState } from '../lib/server-state';
import { CliError } from './errors';
import { probeHealth } from './health';
import { createProcessController, type ProcessController } from './process-control';

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
  spawn: (port: number, logFile: string) => number;
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
  const childPid = d.spawn(port, logFile);

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

/** Re-exec this binary (or `bun <entry>` in dev) with the hidden __serve command. */
function realSpawn(port: number, logFile: string): number {
  const logFd = openSync(logFile, 'a');
  try {
    const proc = Bun.spawn({
      cmd: buildServeCommand(port),
      env: { ...process.env, API_PORT: String(port), MANGO_LOG_FILE: logFile },
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
function buildServeCommand(port: number): string[] {
  if (isStandaloneExecutable()) {
    return [process.execPath, '__serve', String(port)];
  }
  return [process.execPath, Bun.main, '__serve', String(port)];
}

function resolveDeps(deps: Partial<DetachDeps>): DetachDeps {
  return {
    controller: deps.controller ?? createProcessController(),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    spawn: deps.spawn ?? realSpawn,
    readState: deps.readState ?? readState,
    probeHealth: deps.probeHealth ?? probeHealth,
  };
}
