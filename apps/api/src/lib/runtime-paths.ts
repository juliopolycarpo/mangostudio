/**
 * Runtime path helpers for development and standalone executable modes.
 */

import { realpathSync, statSync } from 'node:fs';
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

/** Filename of the runtime binary, beside a standalone hub or in a cargo build. */
const RUNTIME_BINARY_NAME =
  process.platform === 'win32' ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';

/**
 * The repository root of a source checkout: this file is `apps/api/src/lib`.
 * Anchored on the module rather than the working directory, because the hub is
 * started from the root by `bun run dev` and from `apps/api` by its tests.
 */
const SOURCE_CHECKOUT_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/** The cargo profiles a source checkout may have built, in tie-break order. */
const WORKSPACE_BUILD_PROFILES = ['debug', 'release'] as const;

/** The command that builds the runtime a source checkout launches. */
export const RUNTIME_BUILD_COMMAND = 'cargo build -p mangostudio-runtime';

/**
 * Path of the runtime binary that ships beside the hub executable, or null in a
 * source checkout, where the runtime comes from a cargo build instead.
 */
export function getRuntimeBinaryPath(): string | null {
  return isStandaloneExecutable() ? join(getRuntimeBaseDir(), RUNTIME_BINARY_NAME) : null;
}

/**
 * The cargo builds a source checkout may launch, `target/debug` first.
 *
 * @example
 * workspaceRuntimeBinaryCandidates('/repo');
 * // → ['/repo/target/debug/mangostudio-runtime', '/repo/target/release/mangostudio-runtime']
 */
export function workspaceRuntimeBinaryCandidates(
  root: string = SOURCE_CHECKOUT_ROOT
): readonly string[] {
  return WORKSPACE_BUILD_PROFILES.map((profile) =>
    join(root, 'target', profile, RUNTIME_BINARY_NAME)
  );
}

/** Modification time of a regular file, or null when there is no file to run. */
function builtAtMs(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The most recently built of `candidates`, or null when none exists.
 *
 * Newest wins because it is the build a developer just made: someone who ran
 * `cargo build --release` after a debug build means the release one, and the
 * reverse holds too. A tie keeps the candidates' order, so `debug` wins it.
 *
 * @example
 * newestRuntimeBuild(workspaceRuntimeBinaryCandidates()); // '/repo/target/debug/…' or null
 */
export function newestRuntimeBuild(candidates: readonly string[]): string | null {
  let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
  for (const path of candidates) {
    const mtimeMs = builtAtMs(path);
    if (mtimeMs === null) continue;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

/**
 * No runtime binary could be found for the hub to launch. Raised instead of
 * launching anything else: there is no fallback runtime, so a missing binary
 * has to be visible and name its fix.
 */
export class RuntimeBinaryNotFoundError extends Error {
  override readonly name = 'RuntimeBinaryNotFoundError';

  constructor(readonly searched: readonly string[]) {
    super(
      `No mangostudio-runtime binary was found; searched ${searched.join(', ')}. ` +
        `Run "${RUNTIME_BUILD_COMMAND}" from the repository root, or set ` +
        'MANGOSTUDIO_RUNTIME_BINARY to a runtime binary.'
    );
  }
}

export interface RuntimeLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Which source {@link resolveRuntimeLaunchCommand} used, most specific first:
 * `env` — `MANGOSTUDIO_RUNTIME_BINARY`; `config` — a stdio environment's own
 * `binaryPath`; `sibling` — the binary shipped beside a standalone hub;
 * `workspace-build` — the newest cargo build in a source checkout. This is for
 * logs and diagnostics, not the wire — it never leaves the hub process.
 */
export type RuntimeLaunchSource = 'env' | 'config' | 'sibling' | 'workspace-build';

/**
 * A resolved launch command plus which source picked it. `sshLaunch` and
 * `wslLaunchCommand` build a plain {@link RuntimeLaunchCommand} of their
 * own — the sources here only describe how a runtime on this machine is
 * resolved, and neither of those is one of them.
 */
export interface ResolvedRuntimeLaunch extends RuntimeLaunchCommand {
  readonly source: RuntimeLaunchSource;
}

export interface ResolveRuntimeLaunchOptions {
  /** Where a source checkout's cargo builds live; defaults to this checkout's root. */
  readonly workspaceRoot?: string;
}

/**
 * The runtime binary the hub runs on its own machine — Local, and a stdio
 * environment with no `binaryPath` — in priority order: an explicit
 * `MANGOSTUDIO_RUNTIME_BINARY` override, the per-environment `binaryPath`, the
 * sibling binary next to a standalone install, and in a source checkout the
 * newest of `target/debug` and `target/release`. Every element is a discrete
 * argument — the transport never accepts a command string to interpolate.
 *
 * Throws {@link RuntimeBinaryNotFoundError} when a source checkout has no build.
 * A sibling path is returned without checking it exists: the spawn reports a
 * missing one with the reinstall advice a standalone install needs.
 *
 * @example
 * const launch = resolveRuntimeLaunchCommand(); // { command: '…/mangostudio-runtime', args: [], source: 'sibling' }
 */
export function resolveRuntimeLaunchCommand(
  binaryPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRuntimeLaunchOptions = {}
): ResolvedRuntimeLaunch {
  const envOverride = getRuntimeBinaryOverride(env);
  if (envOverride) return { command: envOverride, args: [], source: 'env' };

  const override = binaryPath?.trim();
  if (override) return { command: override, args: [], source: 'config' };

  const sibling = getRuntimeBinaryPath();
  if (sibling) return { command: sibling, args: [], source: 'sibling' };

  const candidates = workspaceRuntimeBinaryCandidates(options.workspaceRoot);
  const built = newestRuntimeBuild(candidates);
  if (built) return { command: built, args: [], source: 'workspace-build' };

  throw new RuntimeBinaryNotFoundError(candidates);
}

/**
 * The binary {@link resolveRuntimeLaunchCommand} would launch for Local, or
 * null when a source checkout has none built. For diagnostics that report the
 * binary rather than launch it.
 *
 * @example
 * const path = locateLocalRuntimeBinary(); // '/repo/target/debug/mangostudio-runtime' or null
 */
export function locateLocalRuntimeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return resolveRuntimeLaunchCommand(undefined, env).command;
  } catch (error) {
    if (error instanceof RuntimeBinaryNotFoundError) return null;
    throw error;
  }
}
