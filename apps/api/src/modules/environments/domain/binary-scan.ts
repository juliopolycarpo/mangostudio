import { posix, win32 } from 'node:path';
import type {
  RuntimeId,
  RuntimeInstallation,
  RuntimeOrigin,
  VersionManagerId,
} from '@mangostudio/shared/environments';
import type { PathEnv } from '../../../lib/path-env';

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
  /** Finding to emit when the command runs but its output no longer parses. */
  readonly unparsedVersionCode?: 'not-executable' | 'version-probe-failed';
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
      readonly version: string;
    }
  | {
      readonly kind: 'failure';
      readonly failure: RuntimeScanFailure;
    }
  | null;

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.com']);
const WINDOWS_PATHEXT_FALLBACK = '.EXE;.CMD;.BAT;.COM';

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

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

/** Version-manager roots are compared as prefixes, so trailing separators must go. */
function normalizedRoot(path: string): string {
  return normalizedPath(path.trim()).replace(/\/+$/, '');
}

function detectVersionManager(
  rawPath: string,
  realpath: string,
  deps: BinaryScanDeps
): VersionManagerId | undefined {
  const paths = [rawPath, realpath].map(normalizedPath);
  const configuredRoots = [
    ['nvm', deps.env.NVM_DIR, deps.env.NVM_HOME, deps.env.NVM_SYMLINK],
    ['fnm', deps.env.FNM_DIR],
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

export async function scanRuntime(
  definition: RuntimeDefinition,
  deps: BinaryScanDeps
): Promise<RuntimeScanResult> {
  const installations: RuntimeInstallation[] = [];
  const failures: RuntimeScanFailure[] = [];
  const firstPathByRealpath = new Map<string, string>();
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

      const timeoutMs = Math.min(deps.probeTimeoutMs ?? 2_000, remainingMs);
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
        return candidate.requiresExistenceCheck
          ? {
              kind: 'failure',
              failure: {
                code: definition.unparsedVersionCode ?? 'not-executable',
                path: candidate.path,
              },
            }
          : null;
      }

      const path = await resolveRealpath(candidate.path, deps);
      return { kind: 'installation', candidate, path, version };
    },
    stopWhen ? (result) => result?.kind === 'installation' && stopWhen(result.version) : undefined
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

    installations.push({
      path,
      rawPath: candidate.path,
      version,
      origin:
        candidate.origin === 'configured'
          ? 'configured'
          : managedBy
            ? 'version-manager'
            : candidate.origin,
      ...(candidate.pathIndex !== undefined && { pathIndex: candidate.pathIndex }),
      effective: installations.length === 0,
      ...(aliasOf !== undefined && { aliasOf }),
      ...(managedBy !== undefined && { managedBy }),
    });
  }

  return { installations, failures };
}
