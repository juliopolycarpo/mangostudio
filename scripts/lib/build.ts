import { WORKSPACES, type WorkspaceName } from './config';

const BUILDABLE_WORKSPACES: WorkspaceName[] = ['frontend', 'api', 'runtime'];

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
export function createTurboBuildCommand(workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', 'build', ...filters];
}

function isBuildWorkspace(workspace: WorkspaceName): boolean {
  return BUILDABLE_WORKSPACES.includes(workspace);
}
