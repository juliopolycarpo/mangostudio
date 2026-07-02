/**
 * Detects whether Node.js is available for the Cursor SDK sidecar.
 * The Cursor SDK local agent stream requires Node.js >= 22.13 (Bun is unsupported).
 *
 * Resolution order:
 * 1. Explicitly configured binary (MANGO_NODE_PATH / cursor.node_path) — used
 *    exclusively; a broken configured path reports `cursor.node_invalid`.
 * 2. PATH entries (PATHEXT-aware on Windows, so `node.cmd` shims resolve).
 * 3. A bounded list of well-known install locations (nvm/fnm/volta/Homebrew).
 * 4. Bare binary names resolved by the OS as a last resort.
 * Every candidate must pass a `--version` probe, so a PATH entry that exists
 * but is not executable never wins over a working install later in the list.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ProviderRuntimeUnavailableReason,
  ProviderRuntimeUnavailableReasonParams,
} from '@mangostudio/shared/provider-settings';
import { getConfig } from '../../../lib/config';

const execFileAsync = promisify(execFile);

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;
const CACHE_TTL_MS = 30_000;

export interface NodeRuntimeStatus {
  available: boolean;
  reasonCode?: ProviderRuntimeUnavailableReason;
  reasonParams?: ProviderRuntimeUnavailableReasonParams;
  nodePath?: string;
  version?: string;
}

/** Injectable environment for probeNodeRuntime, faked in unit tests. */
export interface NodeRuntimeProbeDeps {
  platform: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** Configured override (MANGO_NODE_PATH / cursor.node_path); empty = auto-detect. */
  configuredNodePath: string;
  pathExists: (path: string) => boolean;
  /** Runs `<binary> --version`, returning trimmed stdout or null on any failure. */
  probeVersion: (binary: string) => Promise<string | null>;
}

interface NodeRuntimeCache {
  checkedAt: number;
  status: NodeRuntimeStatus;
}

let cached: NodeRuntimeCache | null = null;
let inflight: Promise<NodeRuntimeStatus> | null = null;

function parseNodeVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function meetsMinimumVersion(version: { major: number; minor: number }): boolean {
  if (version.major > MIN_NODE_MAJOR) return true;
  if (version.major < MIN_NODE_MAJOR) return false;
  return version.minor >= MIN_NODE_MINOR;
}

/** Runs `<binary> --version` off the event loop, returning trimmed stdout or null. */
async function probeNodeVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 2_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function defaultProbeDeps(): NodeRuntimeProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    configuredNodePath: getConfig().cursor.nodePath.trim(),
    pathExists: existsSync,
    probeVersion: probeNodeVersion,
  };
}

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.com']);
const WINDOWS_PATHEXT_FALLBACK = '.EXE;.CMD;.BAT;.COM';

/**
 * Binary names to try inside each candidate directory. On Windows the PATHEXT
 * order is honored so `node.cmd` shims (nvm-windows, corporate wrappers) are
 * found, not just `node.exe`.
 */
export function nodeBinaryCandidateNames(
  deps: Pick<NodeRuntimeProbeDeps, 'platform' | 'env'>
): string[] {
  if (deps.platform !== 'win32') return ['node'];

  const pathext = deps.env.PATHEXT?.trim() || WINDOWS_PATHEXT_FALLBACK;
  const names: string[] = [];
  for (const rawExt of pathext.split(';')) {
    const ext = rawExt.trim().toLowerCase();
    if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(ext)) continue;
    const name = `node${ext}`;
    if (!names.includes(name)) names.push(name);
  }
  names.push('node');
  return names;
}

/**
 * Bounded, ordered list of well-known Node install directories probed when
 * PATH lookup fails (e.g. MangoStudio launched from a GUI without a shell
 * profile). Deliberately no filesystem crawling — fixed locations only.
 */
export function wellKnownNodeDirectories(
  deps: Pick<NodeRuntimeProbeDeps, 'platform' | 'env' | 'homeDir'>
): string[] {
  if (deps.platform === 'win32') {
    const { ProgramFiles, LOCALAPPDATA, NVM_SYMLINK, VOLTA_HOME } = deps.env;
    return [
      NVM_SYMLINK,
      ProgramFiles ? join(ProgramFiles, 'nodejs') : undefined,
      deps.env['ProgramFiles(x86)']
        ? join(deps.env['ProgramFiles(x86)'] as string, 'nodejs')
        : undefined,
      LOCALAPPDATA ? join(LOCALAPPDATA, 'Programs', 'nodejs') : undefined,
      VOLTA_HOME ? join(VOLTA_HOME, 'bin') : undefined,
    ].filter((dir): dir is string => Boolean(dir?.trim()));
  }

  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(deps.homeDir, '.volta', 'bin'),
    join(deps.homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
  ];
}

function pathSeparator(platform: string): string {
  return platform === 'win32' ? ';' : ':';
}

interface NodeBinaryCandidate {
  path: string;
  /** Bare names are resolved by the OS (execFile PATH lookup) — skip pathExists. */
  requiresExistenceCheck: boolean;
}

function* iterateNodeBinaryCandidates(deps: NodeRuntimeProbeDeps): Generator<NodeBinaryCandidate> {
  const names = nodeBinaryCandidateNames(deps);
  const pathEntries = (deps.env.PATH ?? '')
    .split(pathSeparator(deps.platform))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  for (const dir of [...pathEntries, ...wellKnownNodeDirectories(deps)]) {
    for (const name of names) {
      const fullPath = join(dir, name);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      yield { path: fullPath, requiresExistenceCheck: true };
    }
  }

  for (const name of names) {
    yield { path: name, requiresExistenceCheck: false };
  }
}

function evaluateNodeVersion(nodePath: string, versionText: string): NodeRuntimeStatus | null {
  const parsed = parseNodeVersion(versionText);
  if (!parsed) return null;
  if (!meetsMinimumVersion(parsed)) {
    return {
      available: false,
      nodePath,
      version: versionText,
      reasonCode: 'cursor.version_insufficient',
      reasonParams: { foundVersion: versionText },
    };
  }
  return { available: true, nodePath, version: versionText };
}

/**
 * Resolves Node availability with injectable deps (exported for unit tests).
 * A configured path is authoritative: it never falls back to auto-detection,
 * so a typo'd MANGO_NODE_PATH surfaces as `cursor.node_invalid` instead of
 * silently running a different Node than the user asked for.
 */
export async function probeNodeRuntime(
  overrides: Partial<NodeRuntimeProbeDeps> = {}
): Promise<NodeRuntimeStatus> {
  const deps: NodeRuntimeProbeDeps = { ...defaultProbeDeps(), ...overrides };

  const configured = deps.configuredNodePath.trim();
  if (configured) {
    const versionText = await deps.probeVersion(configured);
    const status = versionText ? evaluateNodeVersion(configured, versionText) : null;
    if (status) return status;
    return {
      available: false,
      nodePath: configured,
      reasonCode: 'cursor.node_invalid',
      reasonParams: { nodePath: configured },
    };
  }

  let insufficient: NodeRuntimeStatus | null = null;
  for (const candidate of iterateNodeBinaryCandidates(deps)) {
    if (candidate.requiresExistenceCheck && !deps.pathExists(candidate.path)) continue;

    const versionText = await deps.probeVersion(candidate.path);
    if (!versionText) continue;

    const status = evaluateNodeVersion(candidate.path, versionText);
    if (!status) continue;
    if (status.available) return status;
    // Too old — remember the first hit but keep scanning for a newer install.
    insufficient ??= status;
  }

  return insufficient ?? { available: false, reasonCode: 'cursor.node_not_found' };
}

/**
 * Returns cached Node.js availability for the Cursor SDK sidecar.
 *
 * The probe runs `node --version` in a child process; doing so asynchronously
 * keeps it off the event loop so callers on request paths (e.g. the provider
 * settings descriptor endpoint) never block. Concurrent probes are deduped.
 *
 * The 30s TTL means a user who installs Node (or fixes MANGO_NODE_PATH) while
 * MangoStudio is running is picked up on the next probe without a restart;
 * call resetNodeRuntimeCache() to force an immediate re-probe.
 */
export function detectNodeRuntime(options?: { force?: boolean }): Promise<NodeRuntimeStatus> {
  const now = Date.now();
  if (!options?.force && cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.status);
  }

  if (!options?.force && inflight) return inflight;

  const probe = probeNodeRuntime()
    .then((status) => {
      cached = { checkedAt: Date.now(), status };
      return status;
    })
    .finally(() => {
      if (inflight === probe) inflight = null;
    });

  inflight = probe;
  return probe;
}

/** Clears the cached Node runtime probe (tests, config reloads). */
export function resetNodeRuntimeCache(): void {
  cached = null;
  inflight = null;
}
