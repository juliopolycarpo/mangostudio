import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { sanitizeShellEnv } from '../../tools/builtin/_shell-env';
import { formatCursorRuntimeUnavailableReason } from './runtime-reason';

/**
 * Version of the NDJSON protocol spoken over the sidecar's stdio. The sidecar
 * announces it in its `ready` handshake line; the runner rejects a mismatch.
 * Must stay in lockstep with PROTOCOL_VERSION in sidecar/run-agent.mjs (the
 * script cannot import this module — both ship inside the same artifact).
 */
export const CURSOR_SIDECAR_PROTOCOL_VERSION = 1;

/** Keep only the stderr tail so a chatty crashing sidecar cannot grow memory unbounded. */
const MAX_STDERR_CHARS = 16_384;

/** Appends a chunk to a rolling buffer, keeping at most maxChars of the tail. */
export function appendBoundedTail(existing: string, chunk: string, maxChars: number): string {
  const combined = existing + chunk;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

export interface ChildExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnCursorSidecarProcessOptions {
  nodePath: string;
  sidecarScriptPath?: string;
  envSource?: NodeJS.ProcessEnv;
}

export interface SpawnedCursorSidecarProcess {
  child: ChildProcessWithoutNullStreams;
  childExit: Promise<ChildExitStatus>;
  getSpawnError: () => Error | null;
  /** User-readable spawn failure, with ENOENT/EACCES mapped to runtime hints. */
  getSpawnErrorMessage: () => string | null;
  getStderr: () => string;
}

export function resolveCursorSidecarScriptPath(): string {
  return getCursorSidecarScriptPath();
}

export function buildCursorSidecarEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return sanitizeShellEnv({}, source);
}

export function spawnCursorSidecarProcess(
  options: SpawnCursorSidecarProcessOptions
): SpawnedCursorSidecarProcess {
  const child = spawn(
    options.nodePath,
    [options.sidecarScriptPath ?? resolveCursorSidecarScriptPath()],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCursorSidecarEnv(options.envSource),
    }
  );
  const childExit = waitForChildExit(child);

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBoundedTail(stderr, chunk.toString('utf8'), MAX_STDERR_CHARS);
  });

  let spawnError: Error | null = null;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  child.stdin.on('error', () => {
    // Writes after the sidecar exits can emit EPIPE; swallow so it stays uncaught.
  });

  return {
    child,
    childExit,
    getSpawnError: () => spawnError,
    getSpawnErrorMessage: () =>
      spawnError ? describeCursorSpawnError(spawnError, options.nodePath) : null,
    getStderr: () => stderr,
  };
}

/**
 * Maps spawn errnos to the same user-readable runtime hints the availability
 * probe produces: a Node binary removed after the 30s probe cache filled
 * (ENOENT) or one that is not executable (EACCES/EPERM) should not surface as
 * a bare errno string in the chat UI.
 */
export function describeCursorSpawnError(
  error: Error & { code?: string },
  nodePath: string
): string {
  if (error.code === 'ENOENT') {
    return formatCursorRuntimeUnavailableReason('cursor.node_not_found');
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return formatCursorRuntimeUnavailableReason('cursor.node_invalid', { nodePath });
  }
  return error.message || 'Failed to start the Cursor sidecar.';
}

export function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<ChildExitStatus> {
  if (isCursorSidecarClosed(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export function terminateCursorSidecar(child: ChildProcessWithoutNullStreams): void {
  if (!isCursorSidecarClosed(child)) {
    child.kill('SIGTERM');
  }
}

export async function terminateCursorSidecarWithEscalation(
  child: ChildProcessWithoutNullStreams,
  childExit: Promise<ChildExitStatus>,
  graceMs: number
): Promise<void> {
  if (isCursorSidecarClosed(child)) return;
  child.kill('SIGTERM');

  const exited = await Promise.race([
    childExit.then(() => true),
    delay(Math.max(0, graceMs)).then(() => false),
  ]);
  if (!exited && !isCursorSidecarClosed(child)) {
    child.kill('SIGKILL');
  }
}

export function formatCursorSidecarExit(status: ChildExitStatus): string {
  if (status.signal) return `Cursor sidecar exited with signal ${status.signal}.`;
  return `Cursor sidecar exited with code ${status.code}.`;
}

function isCursorSidecarClosed(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
