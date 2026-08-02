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
import type {
  AuthSignalFs,
  BinaryScanDeps,
  NvmDetectionDeps,
  NvmFileSystem,
  RuntimeDefinition,
} from '@mangostudio/shared/environments/detection';
import type { LocationFsProbe } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';

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
  overrides: { readonly env?: Readonly<Record<string, string>> } = {}
): PathEnv {
  return {
    platform: process.platform,
    homeDir: homedir(),
    env: { ...process.env, ...overrides.env },
  };
}

async function probeBinaryVersion(
  binary: string,
  args: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, [...args], { timeout: timeoutMs });
    return stdout.trim() || null;
  } catch {
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
  budget: RuntimeProbeBudget = {}
): BinaryScanDeps {
  return {
    platform: env.platform,
    homeDir: env.homeDir,
    env: env.env,
    pathExists: existsSync,
    probeVersion: probeBinaryVersion,
    realpath,
    ...(budget.probeTimeoutMs !== undefined && { probeTimeoutMs: budget.probeTimeoutMs }),
    ...(budget.totalTimeoutMs !== undefined && { totalTimeoutMs: budget.totalTimeoutMs }),
    ...(budget.maxConcurrency !== undefined && { maxConcurrency: budget.maxConcurrency }),
  };
}

export function createNvmDetectionDeps(env: PathEnv): NvmDetectionDeps {
  return { platform: env.platform, homeDir: env.homeDir, env: env.env, fs: NODE_NVM_FILE_SYSTEM };
}

const NODE_NVM_FILE_SYSTEM: NvmFileSystem = {
  pathExists: existsSync,
  readFile: (path) => readFile(path, 'utf8'),
  readDirectory: async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  },
  realpath,
};

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
