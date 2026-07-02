/**
 * Runtime path helpers for development and standalone executable modes.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function isBunBinary(execPath: string): boolean {
  const executableName = basename(execPath).toLowerCase();
  return executableName === 'bun' || executableName === 'bun.exe';
}

/**
 * Returns true when the API is running as a compiled standalone executable.
 */
export function isStandaloneExecutable(): boolean {
  return !isBunBinary(process.execPath);
}

function getExecutablePath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/**
 * Returns the base directory for runtime sidecar files.
 *
 * In development we use the current working directory so local workspace
 * commands keep writing to the repo. In standalone mode we use the executable
 * directory so `public/` and `uploads/` resolve beside the binary.
 */
export function getRuntimeBaseDir(): string {
  if (isStandaloneExecutable()) {
    return dirname(getExecutablePath());
  }

  return process.cwd();
}

/**
 * Returns the default frontend public directory for the current runtime mode.
 */
export function getDefaultFrontendDir(): string {
  if (isStandaloneExecutable()) {
    return join(getRuntimeBaseDir(), 'public');
  }

  // In monorepo dev mode, look into apps/frontend/dist
  const monorepoFrontend = join(getRuntimeBaseDir(), 'apps', 'frontend', 'dist');
  if (existsSync(monorepoFrontend)) {
    return monorepoFrontend;
  }

  // Fallback to local public dir
  return join(getRuntimeBaseDir(), 'public');
}

/** Returns the Cursor SDK sidecar script path for the current runtime mode. */
export function getCursorSidecarScriptPath(): string {
  const devSidecar = join(import.meta.dir, '../services/providers/cursor/sidecar/run-agent.mjs');
  if (existsSync(devSidecar)) {
    return devSidecar;
  }

  return join(getRuntimeBaseDir(), 'cursor-sidecar', 'run-agent.mjs');
}
