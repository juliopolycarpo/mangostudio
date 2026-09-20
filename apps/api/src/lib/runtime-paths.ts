/**
 * Runtime path helpers for development and standalone executable modes.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getRuntimeBinaryOverride } from './config';

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
 * Which of the four sources {@link resolveRuntimeLaunchCommand} tried actually
 * chose the command, most specific first: `env` — `MANGOSTUDIO_RUNTIME_BINARY`;
 * `config` — the environment's own `binaryPath`; `sibling` — the binary shipped
 * beside a standalone hub install; `bun-source` — the TS runtime entry run
 * through the current Bun, for a source checkout with no binary built. This is
 * for logs and diagnostics, not the wire — it never leaves the hub process.
 */
export type RuntimeLaunchSource = 'env' | 'config' | 'sibling' | 'bun-source';

/**
 * A resolved launch command plus which source picked it. `sshLaunch` and
 * `wslLaunchCommand` build a plain {@link RuntimeLaunchCommand} of their
 * own — the four sources here only describe how a local stdio launch is
 * resolved, and neither of those is one of them.
 */
export interface ResolvedRuntimeLaunch extends RuntimeLaunchCommand {
  readonly source: RuntimeLaunchSource;
}

/**
 * argv prefix for a runtime child process, in priority order: an explicit
 * `MANGOSTUDIO_RUNTIME_BINARY` override, the per-environment `binaryPath`, the
 * sibling binary next to a standalone install, and finally the workspace
 * entry run through the current Bun for a source checkout. Every element is a
 * discrete argument — the transport never accepts a command string to
 * interpolate.
 */
export function resolveRuntimeLaunchCommand(
  binaryPath?: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedRuntimeLaunch {
  const envOverride = getRuntimeBinaryOverride(env);
  if (envOverride) return { command: envOverride, args: [], source: 'env' };

  const override = binaryPath?.trim();
  if (override) return { command: override, args: [], source: 'config' };

  const sibling = getRuntimeBinaryPath();
  if (sibling) return { command: sibling, args: [], source: 'sibling' };

  return {
    command: process.execPath,
    args: [join(import.meta.dir, '../../../runtime/src/cli.ts')],
    source: 'bun-source',
  };
}
