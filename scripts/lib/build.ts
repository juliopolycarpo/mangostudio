import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { type WorkspaceName, WORKSPACES } from './config';
import { type BinaryTarget, filterBinaryTargets, type ReleasePlatformId } from './release-targets';

const BUILDABLE_WORKSPACES: WorkspaceName[] = ['frontend', 'api'];

export type BinaryCompilerMode = 'native' | 'bytecode';

/** Select the standalone compiler, naming invalid values. @example parseBinaryCompilerMode('native') */
export function parseBinaryCompilerMode(value: unknown = 'native'): BinaryCompilerMode {
  if (value === 'native' || value === 'bytecode') return value;
  throw new Error(`expected binary compiler: native | bytecode | received: ${String(value)}`);
}

/**
 * Native builds select the current platform and refuse cross-compilation before setup.
 * Bytecode builds retain the complete release-target selection.
 * @example binaryBuildTargets('native', 'linux-x64')
 */
export function binaryBuildTargets(
  compiler: BinaryCompilerMode,
  host: ReleasePlatformId | null,
  platform?: string
): BinaryTarget[] {
  if (compiler === 'native' && !host) {
    throw new Error('expected a supported native build host | received: unknown platform or libc');
  }
  const targets = filterBinaryTargets(
    platform ?? (compiler === 'native' ? (host ?? undefined) : undefined)
  );
  if (targets.length === 0) {
    throw new Error(`expected a release platform or Bun target | received: ${String(platform)}`);
  }
  const foreign =
    compiler === 'native' ? targets.find((target) => target.arch !== host) : undefined;
  if (foreign) {
    throw new Error(
      `expected native build target: ${host} | received: ${foreign.arch}. ` +
        'Run on the target platform, or select --compiler bytecode for cross-compilation.'
    );
  }
  return targets;
}

export interface BinaryCompileDefines {
  readonly buildTime: string;
  readonly buildInfo: {
    readonly builtAt: string;
    readonly gitSha: string;
    readonly gitDirty: boolean | 'unknown';
  };
  readonly buildType: string;
  readonly version: string;
  /** The release platform id (`linux-x64`, `windows-arm64`, ...) this target compiles for. */
  readonly platformId: string;
}

/**
 * `--define` flags stamped into every standalone binary compile: the build
 * provenance the hub and runtime report at runtime, plus the release platform
 * id (`BUILD_PLATFORM_ID`) a release binary reads back through
 * `resolveBuildPlatformId` to know which release asset it is, without having
 * to guess from `process.platform`/`process.arch` the way a source checkout
 * must.
 * // Usage: binaryCompileDefines({ buildTime, buildInfo, buildType: 'production', version: '0.1.0', platformId: 'linux-x64' })
 */
export function binaryCompileDefines(context: BinaryCompileDefines): string[] {
  return [
    '--define',
    `process.env.BUILD_TIME=${JSON.stringify(context.buildTime)}`,
    '--define',
    `process.env.BUILD_BUILT_AT=${JSON.stringify(context.buildInfo.builtAt)}`,
    '--define',
    `process.env.BUILD_GIT_SHA=${JSON.stringify(context.buildInfo.gitSha)}`,
    '--define',
    `process.env.BUILD_GIT_DIRTY=${JSON.stringify(String(context.buildInfo.gitDirty))}`,
    '--define',
    `process.env.BUILD_TYPE=${JSON.stringify(context.buildType)}`,
    '--define',
    `process.env.VERSION=${JSON.stringify(context.version)}`,
    '--define',
    `process.env.BUILD_PLATFORM_ID=${JSON.stringify(context.platformId)}`,
    '--define',
    'process.env.NODE_ENV="production"',
  ];
}

/**
 * Compile native machine code with unused runtime features trimmed. Bytecode is
 * an explicit fallback that can cross-compile and retains ESM for top-level await.
 * @example binaryCompileFlags('production', 'native')
 */
export function binaryCompileFlags(
  buildType: string,
  compiler: BinaryCompilerMode = 'native'
): string[] {
  const flags = [
    compiler === 'native' ? '--aot' : '--bytecode',
    '--trim',
    '--format=esm',
    '--sourcemap=external',
  ];
  if (buildType === 'production') flags.push('--minify');
  return flags;
}

export interface BuildSelection {
  runnableWorkspaces: WorkspaceName[];
  skippedWorkspaces: WorkspaceName[];
}

/** Select only workspaces that expose a build entrypoint. // Usage: selectBuildWorkspaces(['api']); */
export function selectBuildWorkspaces(workspaces: WorkspaceName[]): BuildSelection {
  return {
    runnableWorkspaces: workspaces.filter(isBuildWorkspace),
    skippedWorkspaces: workspaces.filter((workspace) => !isBuildWorkspace(workspace)),
  };
}

/** Build a filtered Turbo build command. // Usage: createTurboBuildCommand(['frontend']); */
export function createTurboBuildCommand(
  workspaces: WorkspaceName[],
  cacheArguments: readonly string[] = []
): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', 'build', ...filters, ...cacheArguments];
}

function isBuildWorkspace(workspace: WorkspaceName): boolean {
  return BUILDABLE_WORKSPACES.includes(workspace);
}

/**
 * Where the standalone build parks the previous frontend bundle while the
 * sidecar rebuilds: a sibling of `dist/` keyed by the build's pid, so two
 * builds never share one. Turbo hashes every file Git does not ignore, so the
 * root `.gitignore` must carry a rule matching this name; the build-script test
 * takes the name from here and fails when no rule matches it.
 * // Usage: frontendDistAsidePath('/repo/apps/frontend/dist', 4242) // → '/repo/apps/frontend/dist.aside-4242'
 */
export function frontendDistAsidePath(frontendDist: string, pid: number): string {
  return `${frontendDist}.aside-${pid}`;
}

/**
 * Delete the standalone `README.md` left by an earlier build, before a binary build starts.
 *
 * The README is the completion marker `archive-assets.ts` looks for, written only after every
 * platform has built and verified. A failed rebuild into a dirty output directory must not pass
 * for a finished one on the strength of the previous build's README.
 * // Usage: discardStandaloneReadme('.mango/out')
 */
export function discardStandaloneReadme(outDir: string): void {
  rmSync(join(outDir, 'README.md'), { force: true });
}
