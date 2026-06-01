/**
 * `serve` command: start the server in the foreground, or detached with -d.
 * Enforces a single running instance before doing any work.
 */

import { displayHost, getConfig } from '../../lib/config';
import { isStateLive, readState, removeState } from '../../lib/server-state';
import { assertValidPort, type ServeArgs } from '../args';
import { spawnDetached } from '../detach';
import { CliError } from '../errors';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';
import { assertServeConfig } from '../serve-config-guard';

export interface ServeDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  spawnDetached: typeof spawnDetached;
}

/** Start the server foreground, or in the background when detached. // Usage: await runServe({ detached: true }) */
export async function runServe(args: ServeArgs, deps: Partial<ServeDeps> = {}): Promise<void> {
  if (args.port !== undefined) {
    assertValidPort(args.port);
  }
  await ensureNotRunning(deps);

  if (args.detached) {
    await startDetached(args, deps);
    return;
  }
  await startForeground(args);
}

/** Refuse to start when a live instance already holds the state file. */
async function ensureNotRunning(deps: Partial<ServeDeps>): Promise<void> {
  const controller = deps.controller ?? createProcessController();
  const read = deps.readState ?? readState;
  const remove = deps.removeState ?? removeState;

  const state = await read();
  if (!state) {
    return;
  }
  if (isStateLive(state, (pid) => controller.isAlive(pid))) {
    throw new CliError(
      `Another instance is already running (PID ${state.pid}, port ${state.port}).`
    );
  }
  // Stale file from a crashed server — clear it and continue.
  await remove();
}

async function startDetached(args: ServeArgs, deps: Partial<ServeDeps>): Promise<void> {
  const log = deps.log ?? writeLine;
  const spawn = deps.spawnDetached ?? spawnDetached;
  const config = getConfig();
  assertServeConfig();
  const { server } = config;
  const port = args.port ?? server.port;
  const host = args.host ?? server.host;

  const result = await spawn(port, host);
  log(`MangoStudio started (PID ${result.pid}, ${displayHost(host)}:${result.port}).`);
  log(`Logs: ${result.logFile}`);
}

/**
 * Run the server in this process. Sets API_PORT before the dynamic import so the
 * config singleton (read at app load) picks up a positional port override.
 */
async function startForeground(args: ServeArgs): Promise<void> {
  if (args.port !== undefined) {
    process.env.API_PORT = String(args.port);
  }
  if (args.host !== undefined) {
    process.env.API_HOST = args.host;
  }
  assertServeConfig();
  const { startServer } = await import('../../server/start-server');
  await startServer({ writeStateFile: true });
}
