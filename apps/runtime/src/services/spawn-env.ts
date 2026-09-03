/**
 * Puts an environment's chosen Node and Bun first on `PATH` for every process
 * this runtime spawns.
 *
 * The hub resolves a per-environment `ToolchainSelection` (stored choices,
 * `auto` by default) and sends it on every spawn method. This is the one
 * place that turns that selection into an env var patch: each consumer
 * (`shell.run`, `terminal.open`, `install.run`, `external-agent.open`) applies
 * its own secret policy on top of the result, so nothing here decides what
 * else is forwarded — only where Node and Bun are found.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { ToolchainChoice, ToolchainSelection } from '@mangostudio/shared/environments';
import {
  normalizeNodeVersion,
  wellKnownNodeDirectories,
} from '@mangostudio/shared/environments/detection';

/** Minimal, synchronous filesystem seam — a live probe never needs more than this. */
export interface SpawnEnvFs {
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string | null;
}

/** Platform facts the resolution needs, injected so tests never touch a real machine. */
export interface SpawnEnvHost {
  readonly platform: string;
  readonly homeDir: string;
  readonly fs: SpawnEnvFs;
}

export interface BuildSpawnEnvOptions extends SpawnEnvHost {
  readonly source: NodeJS.ProcessEnv;
  /** Absent: older hubs keep today's behaviour, `source` is copied unchanged. */
  readonly toolchain?: ToolchainSelection;
}

function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const NODE_SPAWN_ENV_FS: SpawnEnvFs = {
  exists: existsSync,
  readFile: readTextFileOrNull,
};

/** The real machine this runtime is running on. Captured once; these facts do not change mid-process. */
export const nodeSpawnEnvHost: SpawnEnvHost = {
  platform: process.platform,
  homeDir: homedir(),
  fs: NODE_SPAWN_ENV_FS,
};

/**
 * Finds the PATH-shaped key already present in `env`, case-insensitively.
 *
 * `process.env` answers `PATH` on Windows through a proxy that a plain-object
 * copy does not have; every reader of a plain env object has to do this
 * lookup itself, or a Windows install/agent spawn quietly loses PATH.
 * // Usage: findPathKey({ Path: 'C:\\x' }, 'PATH') // => 'Path'
 */
export function findPathKey(
  env: Readonly<Record<string, string | undefined>>,
  fallback: string
): string {
  if (fallback in env) return fallback;
  const existing = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  return existing ?? fallback;
}

/** nvm alias names and the `lts/<codename>` pointers real nvm writes into its alias cache. */
const SAFE_ALIAS_PATTERN = /^[a-zA-Z0-9_.*/-]+$/;

/** Backstop against a cyclic alias file; the `seen` set is the real guard. */
const MAX_ALIAS_CHAIN = 8;

/**
 * Follows nvm's `alias/default` through however many pointers it names — an
 * alias may name another alias, e.g. `lts/*` → `lts/jod` → `v22.13.0` — to the
 * concrete version it resolves to, or `undefined` if the chain never lands on
 * one.
 */
function resolveNvmDefaultVersion(fs: SpawnEnvFs, nvmDir: string): string | undefined {
  let current = fs.readFile(posix.join(nvmDir, 'alias', 'default'))?.trim();
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_ALIAS_CHAIN; hop += 1) {
    if (!current) return undefined;
    const version = normalizeNodeVersion(current);
    if (version) return version;
    if (!SAFE_ALIAS_PATTERN.test(current) || seen.has(current)) return undefined;
    seen.add(current);
    const aliasPath = current.startsWith('lts/')
      ? posix.join(nvmDir, 'alias', 'lts', current.slice('lts/'.length))
      : posix.join(nvmDir, 'alias', current);
    current = fs.readFile(aliasPath)?.trim();
  }
  return undefined;
}

/** Which env var a resolved directory should be recorded under, and its value. */
interface ManagerEnvVar {
  readonly key: 'NVM_DIR' | 'FNM_DIR' | 'BUN_INSTALL';
  readonly value: string;
}

interface ToolchainDirResolution {
  readonly dir: string;
  /** Set only when the dir came from a version manager whose root was not already configured. */
  readonly manager?: ManagerEnvVar;
}

function resolveExplicitDir(path: string, platform: string): ToolchainDirResolution {
  const pathApi = platform === 'win32' ? win32 : posix;
  return { dir: pathApi.dirname(path) };
}

/**
 * `auto` for node: nvm's default alias, then fnm's default alias, then the
 * well-known install locations — in that order, stopping at the first
 * directory that actually contains a `node` binary. Never nvm on win32: nvm
 * itself does not run there.
 */
function resolveAutoNodeDir(
  source: NodeJS.ProcessEnv,
  host: SpawnEnvHost
): ToolchainDirResolution | undefined {
  const binaryName = host.platform === 'win32' ? 'node.exe' : 'node';

  if (host.platform !== 'win32') {
    const configuredNvmDir = source.NVM_DIR?.trim();
    const nvmDir = configuredNvmDir || posix.join(host.homeDir, '.nvm');
    const version = resolveNvmDefaultVersion(host.fs, nvmDir);
    if (version) {
      const dir = posix.join(nvmDir, 'versions', 'node', `v${version}`, 'bin');
      if (host.fs.exists(posix.join(dir, binaryName))) {
        return {
          dir,
          ...(!configuredNvmDir && { manager: { key: 'NVM_DIR', value: nvmDir } }),
        };
      }
    }
  }

  const configuredFnmDir = source.FNM_DIR?.trim();
  const fnmRoot =
    configuredFnmDir ||
    (host.platform === 'win32'
      ? source.APPDATA?.trim()
        ? win32.join(source.APPDATA.trim(), 'fnm')
        : undefined
      : posix.join(host.homeDir, '.local', 'share', 'fnm'));
  if (fnmRoot) {
    const pathApi = host.platform === 'win32' ? win32 : posix;
    const dir =
      host.platform === 'win32'
        ? win32.join(fnmRoot, 'aliases', 'default')
        : posix.join(fnmRoot, 'aliases', 'default', 'bin');
    if (host.fs.exists(pathApi.join(dir, binaryName))) {
      return {
        dir,
        ...(!configuredFnmDir && { manager: { key: 'FNM_DIR', value: fnmRoot } }),
      };
    }
  }

  const pathApi = host.platform === 'win32' ? win32 : posix;
  for (const dir of wellKnownNodeDirectories({
    platform: host.platform,
    homeDir: host.homeDir,
    env: source,
  })) {
    if (host.fs.exists(pathApi.join(dir, binaryName))) return { dir };
  }

  return undefined;
}

/** `auto` for bun: `$BUN_INSTALL/bin`, or `~/.bun/bin` when it is not set. */
function resolveAutoBunDir(
  source: NodeJS.ProcessEnv,
  host: SpawnEnvHost
): ToolchainDirResolution | undefined {
  const pathApi = host.platform === 'win32' ? win32 : posix;
  const binaryName = host.platform === 'win32' ? 'bun.exe' : 'bun';
  const configuredRoot = source.BUN_INSTALL?.trim();
  const bunRoot = configuredRoot || pathApi.join(host.homeDir, '.bun');
  const dir = pathApi.join(bunRoot, 'bin');
  if (!host.fs.exists(pathApi.join(dir, binaryName))) return undefined;
  return {
    dir,
    ...(!configuredRoot && { manager: { key: 'BUN_INSTALL', value: bunRoot } }),
  };
}

function resolveToolchainDir(
  runtime: 'node' | 'bun',
  choice: ToolchainChoice,
  source: NodeJS.ProcessEnv,
  host: SpawnEnvHost
): ToolchainDirResolution | undefined {
  if (choice !== 'auto') return resolveExplicitDir(choice, host.platform);
  return runtime === 'node' ? resolveAutoNodeDir(source, host) : resolveAutoBunDir(source, host);
}

/**
 * Builds the env for a process this runtime is about to spawn: at most one
 * directory per runtime (node, then bun) prepended to `PATH`, never the whole
 * well-known list — reordering `/usr/local/bin` ahead of the inherited PATH
 * would change which `git` runs, not just which `node`.
 *
 * @example
 * ```ts
 * const env = buildSpawnEnv({
 *   source: process.env,
 *   toolchain: { node: 'auto', bun: 'auto' },
 *   ...nodeSpawnEnvHost,
 * });
 * ```
 */
export function buildSpawnEnv(options: BuildSpawnEnvOptions): NodeJS.ProcessEnv {
  const { source, toolchain, platform, homeDir, fs } = options;
  const env: NodeJS.ProcessEnv = { ...source };
  if (!toolchain) return env;

  const host: SpawnEnvHost = { platform, homeDir, fs };
  const node = resolveToolchainDir('node', toolchain.node, source, host);
  const bun = resolveToolchainDir('bun', toolchain.bun, source, host);

  for (const resolved of [node, bun]) {
    const manager = resolved?.manager;
    if (!manager) continue;
    if (source[manager.key]?.trim()) continue;
    env[manager.key] = manager.value;
  }

  const dirs = [node?.dir, bun?.dir].filter((dir): dir is string => Boolean(dir));
  if (dirs.length === 0) return env;

  const pathKey = findPathKey(source, platform === 'win32' ? 'Path' : 'PATH');
  const separator = platform === 'win32' ? ';' : ':';
  const existing = source[pathKey];
  env[pathKey] = (existing ? [...dirs, existing] : dirs).join(separator);
  return env;
}
