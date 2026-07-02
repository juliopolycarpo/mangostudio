/**
 * Provider-agnostic Node.js runtime detection for SDK sidecars.
 *
 * Resolution order:
 * 1. Explicitly configured binary supplied by the provider. A broken
 *    configured path reports the provider's `nodeInvalid` reason and does not
 *    fall back to PATH.
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

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 30_000;

export interface NodeRuntimeReasonParams {
  foundVersion?: string;
  nodePath?: string;
  packageName?: string;
  sidecarPath?: string;
}

export interface NodeRuntimeStatus<ReasonCode extends string = string> {
  available: boolean;
  reasonCode?: ReasonCode;
  reasonParams?: NodeRuntimeReasonParams;
  nodePath?: string;
  version?: string;
}

export interface MinimumNodeVersion {
  major: number;
  minor: number;
}

export interface NodeRuntimeReasonCodes<ReasonCode extends string> {
  nodeNotFound: ReasonCode;
  nodeInvalid: ReasonCode;
  versionInsufficient: ReasonCode;
}

export interface NodeRuntimeDetectorOptions<ReasonCode extends string> {
  minimumVersion: MinimumNodeVersion;
  reasonCodes: NodeRuntimeReasonCodes<ReasonCode>;
  getConfiguredNodePath?: () => string;
  cacheTtlMs?: number;
}

/** Injectable environment for probeNodeRuntime, faked in unit tests. */
export interface NodeRuntimeProbeDeps {
  platform: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** Configured override supplied by the provider; empty means auto-detect. */
  configuredNodePath: string;
  pathExists: (path: string) => boolean;
  /** Runs `<binary> --version`, returning trimmed stdout or null on any failure. */
  probeVersion: (binary: string) => Promise<string | null>;
}

interface NodeRuntimeCache<ReasonCode extends string> {
  checkedAt: number;
  status: NodeRuntimeStatus<ReasonCode>;
}

export interface NodeRuntimeDetector<ReasonCode extends string> {
  detectNodeRuntime(options?: { force?: boolean }): Promise<NodeRuntimeStatus<ReasonCode>>;
  probeNodeRuntime(
    overrides?: Partial<NodeRuntimeProbeDeps>
  ): Promise<NodeRuntimeStatus<ReasonCode>>;
  resetNodeRuntimeCache(): void;
}

function parseNodeVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function meetsMinimumVersion(
  version: { major: number; minor: number },
  minimumVersion: MinimumNodeVersion
): boolean {
  if (version.major > minimumVersion.major) return true;
  if (version.major < minimumVersion.major) return false;
  return version.minor >= minimumVersion.minor;
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

function defaultProbeDeps(options: NodeRuntimeDetectorOptions<string>): NodeRuntimeProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    configuredNodePath: options.getConfiguredNodePath?.().trim() ?? '',
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
 * PATH lookup fails (for example, app launched from a GUI without shell
 * profile). Deliberately no filesystem crawling: fixed locations only.
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
  /** Bare names are resolved by the OS (execFile PATH lookup): skip pathExists. */
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

function evaluateNodeVersion<ReasonCode extends string>(
  nodePath: string,
  versionText: string,
  options: NodeRuntimeDetectorOptions<ReasonCode>
): NodeRuntimeStatus<ReasonCode> | null {
  const parsed = parseNodeVersion(versionText);
  if (!parsed) return null;
  if (!meetsMinimumVersion(parsed, options.minimumVersion)) {
    return {
      available: false,
      nodePath,
      version: versionText,
      reasonCode: options.reasonCodes.versionInsufficient,
      reasonParams: { foundVersion: versionText },
    };
  }
  return { available: true, nodePath, version: versionText };
}

/**
 * Resolves Node availability with injectable deps (exported through the
 * detector for unit tests). A configured path is authoritative: it never falls
 * back to auto-detection, so typos surface as the provider's node-invalid
 * reason instead of silently running a different Node.
 */
async function probeRuntime<ReasonCode extends string>(
  options: NodeRuntimeDetectorOptions<ReasonCode>,
  overrides: Partial<NodeRuntimeProbeDeps> = {}
): Promise<NodeRuntimeStatus<ReasonCode>> {
  const deps: NodeRuntimeProbeDeps = { ...defaultProbeDeps(options), ...overrides };

  const configured = deps.configuredNodePath.trim();
  if (configured) {
    const versionText = await deps.probeVersion(configured);
    const status = versionText ? evaluateNodeVersion(configured, versionText, options) : null;
    if (status) return status;
    return {
      available: false,
      nodePath: configured,
      reasonCode: options.reasonCodes.nodeInvalid,
      reasonParams: { nodePath: configured },
    };
  }

  let insufficient: NodeRuntimeStatus<ReasonCode> | null = null;
  for (const candidate of iterateNodeBinaryCandidates(deps)) {
    if (candidate.requiresExistenceCheck && !deps.pathExists(candidate.path)) continue;

    const versionText = await deps.probeVersion(candidate.path);
    if (!versionText) continue;

    const status = evaluateNodeVersion(candidate.path, versionText, options);
    if (!status) continue;
    if (status.available) return status;
    // Too old: remember the first hit but keep scanning for a newer install.
    insufficient ??= status;
  }

  return insufficient ?? { available: false, reasonCode: options.reasonCodes.nodeNotFound };
}

/**
 * Creates a cached runtime detector for one provider-side sidecar. Each
 * provider gets its own cache so different minimum Node versions or configured
 * binary paths cannot bleed into each other.
 */
export function createNodeRuntimeDetector<ReasonCode extends string>(
  options: NodeRuntimeDetectorOptions<ReasonCode>
): NodeRuntimeDetector<ReasonCode> {
  let cached: NodeRuntimeCache<ReasonCode> | null = null;
  let inflight: Promise<NodeRuntimeStatus<ReasonCode>> | null = null;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  return {
    probeNodeRuntime(overrides?: Partial<NodeRuntimeProbeDeps>) {
      return probeRuntime(options, overrides);
    },

    detectNodeRuntime(detectOptions?: { force?: boolean }) {
      const now = Date.now();
      if (!detectOptions?.force && cached && now - cached.checkedAt < cacheTtlMs) {
        return Promise.resolve(cached.status);
      }

      if (!detectOptions?.force && inflight) return inflight;

      const probe = probeRuntime(options)
        .then((status) => {
          cached = { checkedAt: Date.now(), status };
          return status;
        })
        .finally(() => {
          if (inflight === probe) inflight = null;
        });

      inflight = probe;
      return probe;
    },

    resetNodeRuntimeCache() {
      cached = null;
      inflight = null;
    },
  };
}
