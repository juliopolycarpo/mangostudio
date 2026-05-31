/**
 * Boots the MangoStudio API server: migrations, observability restore, frontend
 * wiring, port binding, single-instance state file, and graceful shutdown.
 * Shared by the foreground `serve` and the detached `__serve` startup paths.
 */

import { app } from '../app';
import { closeDb } from '../db/database';
import { getConfig, getVersion } from '../lib/config';
import { ensureRuntimeDirs } from '../lib/mango-paths';
import { getDefaultFrontendDir } from '../lib/runtime-paths';
import { removeState, type ServerState, writeState } from '../lib/server-state';
import {
  flushObservabilitySnapshot,
  loadObservabilitySnapshot,
} from '../services/providers/core/provider-observability';
import { registerFrontend } from './frontend-static';
import { runMigrations } from './migrations';

export interface ServerHandle {
  port: number;
  host: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Write the single-instance state file once listening (default true). */
  writeStateFile?: boolean;
}

/** Start the API server and return a handle. // Usage: await startServer({ writeStateFile: true }) */
export async function startServer(options: StartOptions = {}): Promise<ServerHandle> {
  const cfg = getConfig();
  const { port, host } = cfg.server;

  await runMigrations();
  await loadObservabilitySnapshot();
  registerFrontend(app, getDefaultFrontendDir());

  listenOrExit(port, host);

  if (options.writeStateFile !== false) {
    await persistState(port, host);
  }

  logRunning(host, port);
  registerShutdown();

  return { port, host, stop: gracefulStop };
}

/** Bind the server port, exiting with a clear message when it is already in use. */
function listenOrExit(port: number, host: string): void {
  try {
    // reusePort:false (Elysia defaults it to true) so a port already held by
    // another process raises EADDRINUSE instead of silently load-balancing —
    // this server is single-instance and a collision must fail loudly.
    app.listen({ hostname: host, port, reusePort: false });
  } catch (error) {
    if (isAddressInUse(error)) {
      console.error(`[api] Address ${host}:${port} is already in use.`);
      process.exit(1);
    }
    throw error;
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE';
}

/** Record the running instance so status/stop/killserver can manage it. */
async function persistState(port: number, host: string): Promise<void> {
  await ensureRuntimeDirs();
  const state: ServerState = {
    pid: process.pid,
    port,
    host,
    startedAt: Date.now(),
    // Set by the detached parent so `status` can surface the log path; empty in foreground.
    logFile: process.env.MANGO_LOG_FILE ?? '',
    version: getVersion(),
  };
  await writeState(state);
}

function logRunning(host: string, port: number): void {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.warn(`[api] MangoStudio API running on http://${displayHost}:${port}`);
  console.warn(`[api] Scalar UI available at http://${displayHost}:${port}/scalar`);
}

/** Flush observability, drop the state file, and close the database. */
async function gracefulStop(): Promise<void> {
  await flushObservabilitySnapshot();
  await removeState();
  await closeDb();
}

function registerShutdown(): void {
  // Guard against a second signal (e.g. SIGINT + a `stop` SIGTERM) re-running
  // gracefulStop and closing the database twice.
  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (signal === 'SIGINT') {
      console.warn('\n[api] Shutting down...');
    }
    void gracefulStop().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
