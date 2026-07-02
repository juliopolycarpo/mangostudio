import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { sanitizeShellEnv } from '../../tools/builtin/_shell-env';

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
    stderr += chunk.toString('utf8');
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
    getStderr: () => stderr,
  };
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
