/**
 * Runtime path helpers for development and standalone executable modes.
 */

import { realpathSync } from 'node:fs';
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
 * The frontend directory a *source checkout* serves from.
 *
 * There is no standalone branch. A compiled binary serves the frontend from
 * the manifest embedded at build time, and `scripts/build.ts` refuses to
 * produce one without it, so a binary reaching for a directory on disk is a
 * state that cannot be built. The `<executable>/public` sidecar this used to
 * fall back to was never produced by anything: the Docker image copies only the
 * two binaries, and the Homebrew and npm artifacts ship the same way. What it
 * did produce was a silent failure mode — a binary missing its assets booted
 * happily and answered every route API-only.
 *
 * Unconditional rather than existence-checked. The old version fell back to
 * `<cwd>/public` when `apps/frontend/dist` was absent, which turned "the
 * frontend is not built yet" into a path pointing somewhere it was never going
 * to be, and the "no frontend found at" warning then named the wrong directory.
 */
export function getSourceFrontendDir(): string {
  return join(getRuntimeBaseDir(), 'apps', 'frontend', 'dist');
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
