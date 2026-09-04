import { posix, win32 } from 'node:path';
import type { PathEnv } from '../../runtime-env';
import type {
  PathSource,
  RuntimeId,
  RuntimeInstallation,
  RuntimeOrigin,
  VersionManagerId,
} from '../schemas';

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface RuntimeDefinition {
  readonly id: RuntimeId;
  readonly binaryNames: readonly string[];
  readonly versionArgs: readonly string[];
  readonly parseVersion: (stdout: string) => SemVer | null;
  /**
   * Whether a binary that ran but whose version output did not parse still
   * counts as installed. Off by default, which drops the candidate exactly as a
   * probe that never ran does. On, it survives as an installation with a `null`
   * version — for a vendor CLI whose `--version` output drifts on its own
   * release cadence, "ran but unreadable" is not "not installed". The finding
   * that explains the `null` is the analyzer's to raise, not the scan's.
   */
  readonly keepUnparsedVersion?: boolean;
  readonly wellKnownDirs: (env: PathEnv) => readonly string[];
  /** Retains the sidecar detector's final OS-resolved fallback. */
  readonly includeBareBinaryNames?: boolean;
}

interface RuntimeScanFailure {
  readonly code: 'not-executable' | 'probe-timeout' | 'version-probe-failed';
  readonly path: string;
}

export interface RuntimeScanResult {
  readonly installations: readonly RuntimeInstallation[];
  readonly failures: readonly RuntimeScanFailure[];
}

export interface BinaryScanDeps extends PathEnv {
  readonly pathExists: (path: string) => boolean;
  readonly probeVersion: (
    binary: string,
    args: readonly string[],
    timeoutMs: number
  ) => Promise<string | null>;
  readonly realpath: (path: string) => Promise<string>;
  readonly maxConcurrency?: number;
  readonly probeTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly configuredPath?: string;
  readonly configuredOnly?: boolean;
  /**
   * Stops the scan once a probed version satisfies the caller. Candidates are
   * handed out in PATH order, so every candidate ahead of the match has already
   * started and is still awaited — only strictly later ones are skipped. Gate
   * consumers (the sidecar detector) set this to keep their first-match cost;
   * duplicate analysis leaves it unset because it needs the full list.
   */
  readonly stopWhen?: (version: string) => boolean;
}

interface BinaryCandidate {
  readonly path: string;
  readonly origin: RuntimeOrigin;
  readonly pathIndex?: number;
  readonly requiresExistenceCheck: boolean;
}

type CandidateProbeResult =
  | {
      readonly kind: 'installation';
      readonly candidate: BinaryCandidate;
      readonly path: string;
      /** `null` when the binary ran but its output did not parse as a version. */
      readonly version: string | null;
    }
  | {
      readonly kind: 'failure';
      readonly failure: RuntimeScanFailure;
    }
  | null;

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.com']);
const WINDOWS_PATHEXT_FALLBACK = '.EXE;.CMD;.BAT;.COM';

/**
 * How long one `--version` call may take before the candidate is discarded.
 *
 * Windows gets longer because what sits on `PATH` there is usually not the
 * program. Vendor CLIs install as a `.cmd` shim that starts a runtime that
 * loads a bundled script: `cursor-agent --version` measured **~2.1 s** on
 * Windows against well under a second for the same version on Linux, where the
 * binary is native. At the POSIX budget the shim was killed mid-answer and the
 * CLI was reported as not installed — a real install, on `PATH`, signed in.
 *
 * Both numbers are still a bound on a subprocess that sits on the path to
 * rendering a selector, which is why Windows gets a bigger allowance rather
 * than no deadline.
 */
function defaultProbeTimeoutMs(platform: string): number {
  return platform === 'win32' ? 5_000 : 2_000;
}

export function binaryCandidateNames(
  definition: RuntimeDefinition,
  env: Pick<PathEnv, 'platform' | 'env'>
): string[] {
  if (env.platform !== 'win32') return [...definition.binaryNames];

  const pathext = env.env.PATHEXT?.trim() || WINDOWS_PATHEXT_FALLBACK;
  const names: string[] = [];
  for (const binaryName of definition.binaryNames) {
    for (const rawExtension of pathext.split(';')) {
      const extension = rawExtension.trim().toLowerCase();
      if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)) continue;
      const candidateName = `${binaryName}${extension}`;
      if (!names.includes(candidateName)) names.push(candidateName);
    }
    names.push(binaryName);
  }
  return names;
}

function pathSeparator(platform: string): string {
  return platform === 'win32' ? ';' : ':';
}

function* iterateBinaryCandidates(
  definition: RuntimeDefinition,
  deps: BinaryScanDeps
): Generator<BinaryCandidate> {
  const configuredPath = deps.configuredPath?.trim();
  if (configuredPath) {
    yield {
      path: configuredPath,
      origin: 'configured',
      requiresExistenceCheck: false,
    };
    if (deps.configuredOnly) return;
  }

  const pathApi = deps.platform === 'win32' ? win32 : posix;
  const names = binaryCandidateNames(definition, deps);
  const pathEntries = (deps.env.PATH ?? '')
    .split(pathSeparator(deps.platform))
    .map((entry) => entry.trim());
  const seen = new Set<string>();

  const appendDirectory = function* (
    directory: string,
    origin: BinaryCandidate['origin'],
    pathIndex?: number
  ): Generator<BinaryCandidate> {
    for (const name of names) {
      const path = pathApi.join(directory, name);
      const key = deps.platform === 'win32' ? path.toLowerCase() : path;
      if (seen.has(key)) continue;
      seen.add(key);
      yield { path, origin, pathIndex, requiresExistenceCheck: true };
    }
  };

  for (const [pathIndex, directory] of pathEntries.entries()) {
    if (!directory) continue;
    yield* appendDirectory(directory, 'path', pathIndex);
  }
  for (const directory of definition.wellKnownDirs(deps)) {
    yield* appendDirectory(directory, 'well-known');
  }

  if (definition.includeBareBinaryNames) {
    for (const name of names) {
      yield {
        path: name,
        origin: 'path',
        requiresExistenceCheck: false,
      };
    }
  }
}

async function resolveRealpath(path: string, deps: BinaryScanDeps): Promise<string> {
  try {
    return await deps.realpath(path);
  } catch {
    return path;
  }
}

async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<Result>,
  /** Marks a result as terminal; items after that index are left unmapped. */
  isTerminal?: (result: Result) => boolean
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let terminalIndex = Number.POSITIVE_INFINITY;

  const worker = async () => {
    while (nextIndex < items.length && nextIndex <= terminalIndex) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await mapper(items[index] as T);
      results[index] = result;
      if (isTerminal?.(result) && index < terminalIndex) terminalIndex = index;
    }
  };

  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function probeWithTimeout(
  probe: Promise<string | null>,
  timeoutMs: number
): Promise<{ timedOut: true } | { timedOut: false; version: string | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs));
    probe.then(
      (version) => {
        clearTimeout(timer);
        resolve({ timedOut: false, version });
      },
      () => {
        clearTimeout(timer);
        resolve({ timedOut: false, version: null });
      }
    );
  });
}

export function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

/** Version-manager roots are compared as prefixes, so trailing separators must go. */
function normalizedRoot(path: string): string {
  return normalizedPath(path.trim()).replace(/\/+$/, '');
}

/**
 * fnm's root on Windows when `FNM_DIR` is unset, mirroring the POSIX
 * `~/.local/share/fnm` fallback below: fnm's own Windows installer sets
 * neither an environment variable nor a registry key for its default,
 * `%APPDATA%\fnm`, so an install left at that default reads as `system`
 * without this.
 */
export function windowsDefaultFnmDir(env: Pick<PathEnv, 'platform' | 'env'>): string | undefined {
  if (env.platform !== 'win32') return undefined;
  const appData = env.env.APPDATA?.trim();
  return appData ? win32.join(appData, 'fnm') : undefined;
}

function detectVersionManager(
  rawPath: string,
  realpath: string,
  deps: BinaryScanDeps
): VersionManagerId | undefined {
  const paths = [rawPath, realpath].map(normalizedPath);
  const configuredRoots = [
    ['nvm', deps.env.NVM_DIR, deps.env.NVM_HOME, deps.env.NVM_SYMLINK],
    ['fnm', deps.env.FNM_DIR, windowsDefaultFnmDir(deps)],
    ['volta', deps.env.VOLTA_HOME],
  ] as const;

  for (const [manager, ...roots] of configuredRoots) {
    const normalizedRoots = roots
      .filter((root): root is string => Boolean(root?.trim()))
      .map(normalizedRoot)
      .filter(Boolean);
    if (normalizedRoots.some((root) => paths.some((path) => path.startsWith(`${root}/`)))) {
      return manager;
    }
  }

  if (paths.some((path) => path.includes('/.nvm/') || path.includes('/nvm/versions/'))) {
    return 'nvm';
  }
  if (
    paths.some(
      (path) =>
        path.includes('/.fnm/') ||
        path.includes('/.local/share/fnm/') ||
        // macOS default root; `normalizedPath` lowercases but keeps spaces.
        path.includes('/library/application support/fnm/') ||
        path.includes('/fnm_multishells/')
    )
  ) {
    return 'fnm';
  }
  if (paths.some((path) => path.includes('/.volta/'))) {
    return 'volta';
  }
  return undefined;
}

/** Whether `path` resolves under `BUN_INSTALL`, or Bun's own `~/.bun` default. */
function isBunManagedPath(path: string, deps: BinaryScanDeps): boolean {
  const normalizedTarget = normalizedPath(path);
  const roots = [deps.env.BUN_INSTALL, `${deps.homeDir}/.bun`]
    .filter((root): root is string => Boolean(root?.trim()))
    .map(normalizedRoot);
  return roots.some((root) => normalizedTarget.startsWith(`${root}/`));
}

/**
 * Who put an installation where it is, as far as the scanner can tell.
 * `winget` is never assigned here — winget's own MSI is indistinguishable by
 * path from the nodejs.org MSI, so only a live winget probe can attribute it,
 * and that happens after the scan, on the host adapter that ran it.
 */
function resolvePathSource(
  rawPath: string,
  resolvedPath: string,
  managedBy: VersionManagerId | undefined,
  deps: BinaryScanDeps
): PathSource {
  if (managedBy) return managedBy;
  if (isBunManagedPath(rawPath, deps) || isBunManagedPath(resolvedPath, deps)) return 'bun';
  return 'system';
}

export async function scanRuntime(
  definition: RuntimeDefinition,
  deps: BinaryScanDeps
): Promise<RuntimeScanResult> {
  const installations: RuntimeInstallation[] = [];
  const failures: RuntimeScanFailure[] = [];
  const firstPathByRealpath = new Map<string, string>();
  let hasEffectiveInstallation = false;
  const { stopWhen } = deps;
  const candidates = [...iterateBinaryCandidates(definition, deps)].filter(
    (candidate) => !candidate.requiresExistenceCheck || deps.pathExists(candidate.path)
  );
  const deadlineMs = Date.now() + (deps.totalTimeoutMs ?? 5_000);
  const probeResults = await mapWithConcurrency(
    candidates,
    deps.maxConcurrency ?? 4,
    async (candidate): Promise<CandidateProbeResult> => {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        return {
          kind: 'failure',
          failure: { code: 'probe-timeout', path: candidate.path },
        };
      }

      const timeoutMs = Math.min(
        deps.probeTimeoutMs ?? defaultProbeTimeoutMs(deps.platform),
        remainingMs
      );
      const probe = await probeWithTimeout(
        deps.probeVersion(candidate.path, definition.versionArgs, timeoutMs),
        timeoutMs
      );
      if (probe.timedOut) {
        return {
          kind: 'failure',
          failure: { code: 'probe-timeout', path: candidate.path },
        };
      }

      const version = probe.version?.trim();
      if (!version) {
        return candidate.requiresExistenceCheck
          ? {
              kind: 'failure',
              failure: { code: 'not-executable', path: candidate.path },
            }
          : null;
      }
      if (!definition.parseVersion(version)) {
        // A definition that opts in trades the raw failure for a known
        // installation with an unreadable version: the binary answered, so
        // "not installed" would be the wrong story. One that does not opt in
        // keeps the old failure/drop split.
        if (definition.keepUnparsedVersion) {
          const path = await resolveRealpath(candidate.path, deps);
          return { kind: 'installation', candidate, path, version: null };
        }
        return candidate.requiresExistenceCheck
          ? {
              kind: 'failure',
              failure: { code: 'not-executable', path: candidate.path },
            }
          : null;
      }

      const path = await resolveRealpath(candidate.path, deps);
      return { kind: 'installation', candidate, path, version };
    },
    stopWhen
      ? (result) =>
          result?.kind === 'installation' && result.version !== null && stopWhen(result.version)
      : undefined
  );

  for (const probeResult of probeResults) {
    if (!probeResult) continue;
    if (probeResult.kind === 'failure') {
      failures.push(probeResult.failure);
      continue;
    }

    const { candidate, path, version } = probeResult;
    const realpathKey = deps.platform === 'win32' ? path.toLowerCase() : path;
    const aliasOf = firstPathByRealpath.get(realpathKey);
    firstPathByRealpath.set(realpathKey, aliasOf ?? candidate.path);
    const managedBy = detectVersionManager(candidate.path, path, deps);
    const origin: RuntimeOrigin =
      candidate.origin === 'configured'
        ? 'configured'
        : managedBy
          ? 'version-manager'
          : candidate.origin;
    // Only candidates discovered through PATH can win normal shell lookup.
    // Version-manager binaries retain that provenance through `pathIndex`.
    const effective: boolean = candidate.origin === 'path' && !hasEffectiveInstallation;
    hasEffectiveInstallation ||= effective;
    const pathSource = resolvePathSource(candidate.path, path, managedBy, deps);

    installations.push({
      path,
      rawPath: candidate.path,
      version,
      origin,
      ...(candidate.pathIndex !== undefined && { pathIndex: candidate.pathIndex }),
      effective,
      ...(aliasOf !== undefined && { aliasOf }),
      ...(managedBy !== undefined && { managedBy }),
      pathSource,
    });
  }

  return { installations, failures };
}
