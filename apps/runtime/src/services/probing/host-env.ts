/**
 * Node-backed adapters for the detection domain that now lives in
 * `@mangostudio/shared/environments`.
 *
 * The domain is pure and injects every filesystem and spawn seam; this file is
 * the only place that binds those seams to the machine the runtime is running
 * on. That is the whole point of the split: the hub decides *what* to ask for,
 * this host is what actually looks.
 */

import { execFile } from 'node:child_process';
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  type AuthSignalFs,
  type BinaryScanDeps,
  type FnmDetectionDeps,
  type ManagedVersionFileSystem,
  type NvmDetectionDeps,
  type NvmFileSystem,
  parseWingetListOutput,
  type RuntimeDefinition,
  WINGET_LIST_ARGV,
  type WingetOwnership,
} from '@mangostudio/shared/environments/detection';
import type { LocationFsProbe } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { throwIfAborted } from '../cancellation';
import { HIDDEN_WINDOW } from '../process-window';

const execFileAsync = promisify(execFile);

// O_NOFOLLOW makes a final-component symlink fail the open instead of silently
// resolving to its target, which is what keeps a bounded config read from being
// redirected at anything the probe was not asked to look at.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Path inputs for this machine. `overrides.env` carries the variables the hub
 * pins for an environment — the configured MangoStudio library directories,
 * which are product configuration rather than a fact about the host.
 */
export function createRuntimePathEnv(
  overrides: {
    readonly env?: Readonly<Record<string, string>>;
    readonly workspaceRoot?: string;
  } = {}
): PathEnv {
  return {
    platform: process.platform,
    homeDir: homedir(),
    env: withCanonicalPathKey({ ...process.env, ...overrides.env }),
    ...(overrides.workspaceRoot !== undefined && { workspaceRoot: overrides.workspaceRoot }),
  };
}

/**
 * Restores `PATH` after the spread that loses it on Windows.
 *
 * Windows names the variable `Path`, and `process.env` only answers to `PATH`
 * because the runtime proxies it case-insensitively. Spreading into a plain
 * object drops the proxy, so every consumer below — all of which read `PATH` —
 * looks up a key that is not there and finds an empty search path.
 *
 * The symptom is not subtle and was not theoretical: on Windows the binary scan
 * enumerated nothing, so **every** external agent reported `cli-not-installed`
 * with the CLI sitting on `PATH`, signed in.
 *
 * The canonical key is added rather than the original renamed: something
 * downstream may reasonably read `Path` on Windows, and both should agree.
 */
function withCanonicalPathKey(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  if (env.PATH !== undefined) return env;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === 'PATH');
  return key === undefined ? env : { ...env, PATH: env[key] };
}

/**
 * How much longer than the caller's budget the child is allowed to live.
 *
 * The scan races this call against a timer of its own and reports
 * `probe-timeout` when that timer wins. Giving `execFile` the *same* deadline
 * makes the two race each other: whichever fires first decides whether the user
 * is told the probe timed out or that the file is not executable, and on
 * Windows the `execFile` kill won consistently — sending anyone who read the
 * finding to check file permissions on a binary that was merely slow. The grace
 * makes the scan's own timer authoritative; this one is only a backstop for a
 * child that ignores it.
 */
const VERSION_PROBE_GRACE_MS = 250;

async function probeBinaryVersion(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execFileAsync(binary, [...args], {
      timeout: timeoutMs + VERSION_PROBE_GRACE_MS,
      ...HIDDEN_WINDOW,
      ...(signal ? { signal } : {}),
    });
    return stdout.trim() || null;
  } catch (error) {
    // A cancelled probe is the hub's answer, not "this binary is missing".
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throwIfAborted(signal);
    return null;
  }
}

/** Per-scan limits. They live here, next to the spawns they bound, so a slow
 *  link cannot turn a probe into an open-ended wait on the hub's side. */
export interface RuntimeProbeBudget {
  readonly probeTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxConcurrency?: number;
}

export function createBinaryScanDeps(
  env: PathEnv,
  _definition: RuntimeDefinition,
  budget: RuntimeProbeBudget = {},
  signal?: AbortSignal
): BinaryScanDeps {
  return {
    platform: env.platform,
    homeDir: env.homeDir,
    env: env.env,
    pathExists: existsSync,
    probeVersion: (binary, args, timeoutMs) => probeBinaryVersion(binary, args, timeoutMs, signal),
    realpath,
    ...(budget.probeTimeoutMs !== undefined && { probeTimeoutMs: budget.probeTimeoutMs }),
    ...(budget.totalTimeoutMs !== undefined && { totalTimeoutMs: budget.totalTimeoutMs }),
    ...(budget.maxConcurrency !== undefined && { maxConcurrency: budget.maxConcurrency }),
  };
}

/** The filesystem seam nvm's and fnm's detectors share; nvm adds `readFile` on top of it. */
const NODE_MANAGED_VERSION_FILE_SYSTEM: ManagedVersionFileSystem = {
  pathExists: existsSync,
  readDirectory: async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  },
  realpath,
};

export function createNvmDetectionDeps(env: PathEnv): NvmDetectionDeps {
  return { platform: env.platform, homeDir: env.homeDir, env: env.env, fs: NODE_NVM_FILE_SYSTEM };
}

const NODE_NVM_FILE_SYSTEM: NvmFileSystem = {
  ...NODE_MANAGED_VERSION_FILE_SYSTEM,
  readFile: (path) => readFile(path, 'utf8'),
};

export function createFnmDetectionDeps(env: PathEnv): FnmDetectionDeps {
  return {
    platform: env.platform,
    homeDir: env.homeDir,
    env: env.env,
    fs: NODE_MANAGED_VERSION_FILE_SYSTEM,
  };
}

/**
 * Above the caller's 5s scan budget on purpose: `winget list` is slow, this
 * runs once per `probeRuntimes` call rather than once per candidate, and a
 * cancelled probe answers `unknown` instead of hanging the scan. Kept well
 * under the hub's 15s deadline for the whole `probing.runtimes` request,
 * because `unknown` (Node reads as `system`) is a far better outcome than the
 * entire toolchain probe timing out.
 */
const WINGET_OWNERSHIP_TIMEOUT_MS = 8_000;

/**
 * Asks winget whether it owns `packageId`, mapping every failure — the binary
 * missing, a timeout, an unrecognized exit code — to `unknown` rather than
 * throwing: this is one signal among several the card can render without,
 * and it must never be the thing that fails a runtime scan.
 */
export async function probeWingetOwnership(
  packageId: string,
  signal?: AbortSignal
): Promise<WingetOwnership> {
  try {
    const { stdout } = await execFileAsync('winget', WINGET_LIST_ARGV(packageId), {
      timeout: WINGET_OWNERSHIP_TIMEOUT_MS,
      ...HIDDEN_WINDOW,
      ...(signal ? { signal } : {}),
    });
    return parseWingetListOutput(stdout, 0, packageId);
  } catch (error) {
    // A killed-by-timeout or spawn-failed child reports `code` as `null` or a
    // string errno (`ENOENT`), never the exit code the parser needs — both
    // read as `unknown`. Only a child that actually exited non-zero, which
    // `execFile` also surfaces as a rejection, carries a numeric `code`.
    const execError = error as { readonly code?: unknown; readonly stdout?: string };
    if (typeof execError.code !== 'number') return 'unknown';
    return parseWingetListOutput(execError.stdout ?? '', execError.code, packageId);
  }
}

/**
 * Reads at most `maxBytes` from a regular file, validating the descriptor after
 * opening rather than stat-ing a path another process could swap in between.
 */
function readBoundedUtf8(path: string, maxBytes: number): string {
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
    const size = Math.min(stats.size, maxBytes);
    const buffer = Buffer.allocUnsafe(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export const NODE_AUTH_SIGNAL_FS: AuthSignalFs = {
  stat: statSync,
  readFile: readBoundedUtf8,
};

export const NODE_LOCATION_FS_PROBE: LocationFsProbe = {
  exists: existsSync,
  isWritable(path) {
    try {
      accessSync(path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  isReadable(path) {
    try {
      accessSync(path, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  countEntries(path, layout) {
    // Dot-prefixed names can never be resource slugs, so the resource writer's
    // `.slug.suffix.staging` siblings stay out of the reported count.
    return readdirSync(path, { withFileTypes: true }).filter((entry) => {
      if (entry.name.startsWith('.')) return false;
      if (entry.isSymbolicLink()) return true;
      return layout === 'directory-of-dirs' ? entry.isDirectory() : entry.isFile();
    }).length;
  },
};
