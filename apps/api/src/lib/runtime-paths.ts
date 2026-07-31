/**
 * Runtime path helpers for development and standalone executable modes.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getConfig } from './config';

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
 * directory so runtime files such as `uploads/` resolve beside the binary.
 * The frontend is embedded in the binary, not read from disk.
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

/** Filename of the runtime binary that ships beside the hub executable. */
const RUNTIME_BINARY_NAME =
  process.platform === 'win32' ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';

/**
 * Path of the runtime binary that ships beside the hub executable, or null in a
 * source checkout where no binary is built.
 */
export function getRuntimeBinaryPath(): string | null {
  return isStandaloneExecutable() ? join(getRuntimeBaseDir(), RUNTIME_BINARY_NAME) : null;
}

export interface RuntimeLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * argv prefix for a runtime child process. A standalone install runs the
 * sibling binary; a source checkout runs the workspace entry through the
 * current Bun. Every element is a discrete argument — the transport never
 * accepts a command string to interpolate.
 */
export function resolveRuntimeLaunchCommand(binaryPath?: string): RuntimeLaunchCommand {
  const override = binaryPath?.trim();
  if (override) return { command: override, args: [] };

  const sibling = getRuntimeBinaryPath();
  if (sibling) return { command: sibling, args: [] };

  return {
    command: process.execPath,
    args: [join(import.meta.dir, '../../../runtime/src/cli.ts')],
  };
}

/** Returns the Cursor SDK sidecar script path for the current runtime mode. */
export function getCursorSidecarScriptPath(): string {
  const override = getConfig().cursor.sidecarScriptPath.trim();
  if (override) {
    return override;
  }

  const devSidecar = join(import.meta.dir, '../services/providers/cursor/sidecar/run-agent.mjs');
  if (existsSync(devSidecar)) {
    return devSidecar;
  }

  return join(getRuntimeBaseDir(), 'cursor-sidecar', 'run-agent.mjs');
}
