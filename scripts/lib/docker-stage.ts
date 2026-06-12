import { join } from 'node:path';

import {
  type BinaryTarget,
  filterBinaryTargets,
  type ReleasePlatformId,
  releaseArchiveFileName,
} from './release-targets';

export type DockerArch = 'amd64' | 'arm64';

export const DOCKER_ARCHES: readonly DockerArch[] = ['amd64', 'arm64'];

const DOCKER_ARCH_TO_PLATFORM: Record<DockerArch, ReleasePlatformId> = {
  amd64: 'linux-x64-musl',
  arm64: 'linux-arm64-musl',
};

export interface DockerStagePlanOptions {
  readonly rootDir: string;
  readonly outDir?: string;
  readonly contextDir?: string;
  readonly onlyArch?: DockerArch;
}

export interface DockerStageTarget {
  readonly dockerArch: DockerArch;
  readonly platform: BinaryTarget;
  readonly sourceDir: string;
  readonly binaryPath: string;
  readonly publicDir: string;
  readonly contextArchDir: string;
  readonly stagedBinaryPath: string;
  readonly stagedPublicDir: string;
}

export interface DockerStagePlan {
  readonly rootDir: string;
  readonly outDir: string;
  readonly contextDir: string;
  readonly targets: readonly DockerStageTarget[];
}

/** Parse an optional Docker arch filter. // Usage: parseDockerArchFilter('amd64') */
export function parseDockerArchFilter(value: string | undefined): DockerArch | undefined {
  if (!value || value === 'all') return undefined;
  if (isDockerArch(value)) return value;

  throw new Error(`Docker arch must be one of: ${DOCKER_ARCHES.join(', ')}`);
}

/** Create the staging plan for Docker buildx TARGETARCH values. // Usage: createDockerStagePlan({ rootDir }) */
export function createDockerStagePlan(options: DockerStagePlanOptions): DockerStagePlan {
  const outDir = options.outDir ?? join(options.rootDir, '.mango', 'out');
  const contextDir = options.contextDir ?? join(options.rootDir, 'docker-ctx');
  const arches = options.onlyArch ? [options.onlyArch] : DOCKER_ARCHES;

  return {
    rootDir: options.rootDir,
    outDir,
    contextDir,
    targets: arches.map((dockerArch) => createDockerStageTarget(dockerArch, outDir, contextDir)),
  };
}

/** Return the release archive name that seeds one Docker arch. // Usage: dockerReleaseAssetName('1.2.3', 'amd64') */
export function dockerReleaseAssetName(version: string, dockerArch: DockerArch): string {
  return releaseArchiveFileName(version, resolveDockerBinaryTarget(dockerArch));
}

function createDockerStageTarget(
  dockerArch: DockerArch,
  outDir: string,
  contextDir: string
): DockerStageTarget {
  const platform = resolveDockerBinaryTarget(dockerArch);
  const sourceDir = join(outDir, platform.arch);
  const contextArchDir = join(contextDir, dockerArch);

  return {
    dockerArch,
    platform,
    sourceDir,
    binaryPath: join(sourceDir, platform.name),
    publicDir: join(sourceDir, 'public'),
    contextArchDir,
    stagedBinaryPath: join(contextArchDir, platform.name),
    stagedPublicDir: join(contextArchDir, 'public'),
  };
}

function resolveDockerBinaryTarget(dockerArch: DockerArch): BinaryTarget {
  const [target] = filterBinaryTargets(DOCKER_ARCH_TO_PLATFORM[dockerArch]);
  if (!target) {
    throw new Error(`No musl release target configured for Docker arch: ${dockerArch}`);
  }
  return target;
}

function isDockerArch(value: string): value is DockerArch {
  return DOCKER_ARCHES.includes(value as DockerArch);
}
