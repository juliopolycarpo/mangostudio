import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_INFO_FILENAME = 'build-info.json';
export const UNKNOWN_BUILD_VALUE = 'unknown';

export type BuildDirtyState = boolean | 'unknown';

export interface BuildInfo {
  gitSha: string;
  gitDirty: BuildDirtyState;
  builtAt: string;
  buildType: string;
}

export interface BuildInfoDeps {
  env?: Record<string, string | undefined>;
  runGit?: (args: readonly string[]) => string;
}

/** Return the current process build stamp, falling back to a dev git probe. */
export function getBuildInfo(): BuildInfo {
  return resolveBuildInfo();
}

/** Return the checkout stamp only; doctor compares the running server to HEAD. */
export function getCurrentCheckoutBuildInfo(deps: BuildInfoDeps = {}): BuildInfo {
  return resolveDevBuildInfo(deps.runGit ?? runGitCommand);
}

/** Resolve compile-time build metadata or lazily probe git during source runs. */
export function resolveBuildInfo(deps: BuildInfoDeps = {}): BuildInfo {
  const env = deps.env ?? readProcessBuildEnv();
  const stampedSha = env.BUILD_GIT_SHA?.trim();

  if (stampedSha) {
    return {
      gitSha: stampedSha,
      gitDirty: parseDirtyState(env.BUILD_GIT_DIRTY),
      builtAt: env.BUILD_BUILT_AT?.trim() || env.BUILD_TIME?.trim() || UNKNOWN_BUILD_VALUE,
      buildType: env.BUILD_TYPE?.trim() || UNKNOWN_BUILD_VALUE,
    };
  }

  return resolveDevBuildInfo(deps.runGit ?? runGitCommand);
}

function readProcessBuildEnv(): Record<string, string | undefined> {
  return {
    BUILD_BUILT_AT: process.env.BUILD_BUILT_AT,
    BUILD_GIT_DIRTY: process.env.BUILD_GIT_DIRTY,
    BUILD_GIT_SHA: process.env.BUILD_GIT_SHA,
    BUILD_TIME: process.env.BUILD_TIME,
    BUILD_TYPE: process.env.BUILD_TYPE,
  };
}

export function readFrontendBuildInfo(frontendDir: string): BuildInfo | null {
  const path = join(frontendDir, BUILD_INFO_FILENAME);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isBuildInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formatBuildInfo(info: BuildInfo | null | undefined): string {
  if (!info) {
    return UNKNOWN_BUILD_VALUE;
  }

  return `${formatBuildSha(info)} (built ${info.builtAt}, ${formatDirtyState(info.gitDirty)}, ${info.buildType})`;
}

export function formatBuildSha(info: BuildInfo | null | undefined): string {
  return info?.gitSha || UNKNOWN_BUILD_VALUE;
}

export function isKnownBuildSha(info: BuildInfo | null | undefined): info is BuildInfo {
  return Boolean(info?.gitSha && info.gitSha !== UNKNOWN_BUILD_VALUE);
}

function resolveDevBuildInfo(runGit: (args: readonly string[]) => string): BuildInfo {
  const gitSha = readGitValue(runGit, ['rev-parse', '--short=12', 'HEAD']);
  const dirtyOutput = readGitValue(runGit, ['status', '--porcelain']);

  return {
    gitSha: gitSha || UNKNOWN_BUILD_VALUE,
    gitDirty: dirtyOutput === null ? UNKNOWN_BUILD_VALUE : dirtyOutput.length > 0,
    builtAt: 'dev',
    buildType: 'dev',
  };
}

function readGitValue(
  runGit: (args: readonly string[]) => string,
  args: readonly string[]
): string | null {
  try {
    return runGit(args).trim();
  } catch {
    return null;
  }
}

function runGitCommand(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function parseDirtyState(value: string | undefined): BuildDirtyState {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return UNKNOWN_BUILD_VALUE;
}

function formatDirtyState(state: BuildDirtyState): string {
  if (state === true) {
    return 'dirty';
  }
  if (state === false) {
    return 'clean';
  }
  return 'dirty unknown';
}

function isBuildInfo(value: unknown): value is BuildInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.gitSha === 'string' &&
    isDirtyState(candidate.gitDirty) &&
    typeof candidate.builtAt === 'string' &&
    typeof candidate.buildType === 'string'
  );
}

function isDirtyState(value: unknown): value is BuildDirtyState {
  return value === true || value === false || value === UNKNOWN_BUILD_VALUE;
}
