import { join } from 'node:path';

import {
  type BinaryTarget,
  filterBinaryTargets,
  type ReleasePlatformId,
  type ReleaseRuntimeBinaryName,
  releaseArchiveFileName,
  runtimeBinaryName,
} from './release-targets';

export type DockerArch = 'amd64' | 'arm64';
export type DockerVariant = 'bookworm' | 'alpine';

const DOCKER_ARCHES: readonly DockerArch[] = ['amd64', 'arm64'];
const DOCKER_VARIANTS: readonly DockerVariant[] = ['bookworm', 'alpine'];

const DOCKER_PLATFORM_BY_VARIANT: Record<DockerVariant, Record<DockerArch, ReleasePlatformId>> = {
  bookworm: {
    amd64: 'linux-x64',
    arm64: 'linux-arm64',
  },
  alpine: {
    amd64: 'linux-x64-musl',
    arm64: 'linux-arm64-musl',
  },
};

export interface DockerStagePlanOptions {
  readonly rootDir: string;
  readonly outDir?: string;
  readonly contextDir?: string;
  readonly onlyArch?: DockerArch;
  readonly onlyVariant?: DockerVariant;
}

export interface DockerStageTarget {
  readonly dockerVariant: DockerVariant;
  readonly dockerArch: DockerArch;
  readonly platform: BinaryTarget;
  readonly sourceDir: string;
  readonly binaryPath: string;
  readonly runtimeBinaryName: ReleaseRuntimeBinaryName;
  readonly runtimeBinaryPath: string;
  readonly contextArchDir: string;
  readonly stagedBinaryPath: string;
  readonly stagedRuntimeBinaryPath: string;
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

/** Parse an optional Docker variant filter. // Usage: parseDockerVariantFilter('alpine') */
export function parseDockerVariantFilter(value: string | undefined): DockerVariant | undefined {
  if (!value || value === 'all') return undefined;
  if (isDockerVariant(value)) return value;

  throw new Error(`Docker variant must be one of: ${DOCKER_VARIANTS.join(', ')}`);
}

/** Create the staging plan for Docker buildx TARGETARCH values. // Usage: createDockerStagePlan({ rootDir }) */
export function createDockerStagePlan(options: DockerStagePlanOptions): DockerStagePlan {
  const outDir = options.outDir ?? join(options.rootDir, '.mango', 'out');
  const contextDir = options.contextDir ?? join(options.rootDir, 'docker-ctx');
  const arches = options.onlyArch ? [options.onlyArch] : DOCKER_ARCHES;
  const variants = options.onlyVariant ? [options.onlyVariant] : DOCKER_VARIANTS;

  return {
    rootDir: options.rootDir,
    outDir,
    contextDir,
    targets: variants.flatMap((dockerVariant) =>
      arches.map((dockerArch) =>
        createDockerStageTarget(dockerVariant, dockerArch, outDir, contextDir)
      )
    ),
  };
}

/** Return the release archive name that seeds one Docker arch. // Usage: dockerReleaseAssetName('1.2.3', 'amd64') */
export function dockerReleaseAssetName(
  version: string,
  dockerVariant: DockerVariant,
  dockerArch: DockerArch
): string {
  return releaseArchiveFileName(version, resolveDockerBinaryTarget(dockerVariant, dockerArch));
}

function createDockerStageTarget(
  dockerVariant: DockerVariant,
  dockerArch: DockerArch,
  outDir: string,
  contextDir: string
): DockerStageTarget {
  const platform = resolveDockerBinaryTarget(dockerVariant, dockerArch);
  const sourceDir = join(outDir, platform.arch);
  const contextArchDir = join(contextDir, dockerVariant, dockerArch);
  const runtimeName = runtimeBinaryName(platform.name);

  return {
    dockerVariant,
    dockerArch,
    platform,
    sourceDir,
    binaryPath: join(sourceDir, platform.name),
    runtimeBinaryName: runtimeName,
    runtimeBinaryPath: join(sourceDir, runtimeName),
    contextArchDir,
    stagedBinaryPath: join(contextArchDir, platform.name),
    stagedRuntimeBinaryPath: join(contextArchDir, runtimeName),
  };
}

function resolveDockerBinaryTarget(
  dockerVariant: DockerVariant,
  dockerArch: DockerArch
): BinaryTarget {
  const [target] = filterBinaryTargets(DOCKER_PLATFORM_BY_VARIANT[dockerVariant][dockerArch]);
  if (!target) {
    throw new Error(`No release target configured for Docker ${dockerVariant}/${dockerArch}`);
  }
  return target;
}

function isDockerArch(value: string): value is DockerArch {
  return DOCKER_ARCHES.includes(value as DockerArch);
}

function isDockerVariant(value: string): value is DockerVariant {
  return DOCKER_VARIANTS.includes(value as DockerVariant);
}
