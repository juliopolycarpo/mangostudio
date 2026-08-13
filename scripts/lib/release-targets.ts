// Canonical standalone binary targets used by the build and release asset
// scripts. Downstream installers and package manifests depend on these IDs.

export type ReleasePlatformId =
  | 'linux-x64'
  | 'linux-arm64'
  | 'windows-x64'
  | 'windows-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64-musl'
  | 'linux-arm64-musl';

type ReleaseArchiveFormat = 'tar.gz' | 'zip';
export type ReleaseBinaryName = 'mangostudio' | 'mangostudio.exe';
export type ReleaseRuntimeBinaryName = 'mangostudio-runtime' | 'mangostudio-runtime.exe';

export interface BinaryTarget {
  readonly target: string;
  readonly arch: ReleasePlatformId;
  readonly name: ReleaseBinaryName;
  readonly archiveFormat: ReleaseArchiveFormat;
}

export const ALL_BINARY_TARGETS: readonly BinaryTarget[] = [
  { target: 'bun-linux-x64', arch: 'linux-x64', name: 'mangostudio', archiveFormat: 'tar.gz' },
  {
    target: 'bun-linux-arm64',
    arch: 'linux-arm64',
    name: 'mangostudio',
    archiveFormat: 'tar.gz',
  },
  {
    target: 'bun-windows-x64',
    arch: 'windows-x64',
    name: 'mangostudio.exe',
    archiveFormat: 'zip',
  },
  {
    target: 'bun-windows-arm64',
    arch: 'windows-arm64',
    name: 'mangostudio.exe',
    archiveFormat: 'zip',
  },
  {
    target: 'bun-darwin-x64',
    arch: 'darwin-x64',
    name: 'mangostudio',
    archiveFormat: 'tar.gz',
  },
  {
    target: 'bun-darwin-arm64',
    arch: 'darwin-arm64',
    name: 'mangostudio',
    archiveFormat: 'tar.gz',
  },
  {
    target: 'bun-linux-x64-musl',
    arch: 'linux-x64-musl',
    name: 'mangostudio',
    archiveFormat: 'tar.gz',
  },
  {
    target: 'bun-linux-arm64-musl',
    arch: 'linux-arm64-musl',
    name: 'mangostudio',
    archiveFormat: 'tar.gz',
  },
];

/**
 * Name of the runtime binary that ships beside the hub binary. The hub resolves
 * it as a sibling of its own executable, so the two always travel together.
 * // Usage: runtimeBinaryName(target.name) // → 'mangostudio-runtime'
 */
export function runtimeBinaryName(binaryName: ReleaseBinaryName): ReleaseRuntimeBinaryName {
  return binaryName === 'mangostudio.exe' ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';
}

/**
 * Top-level layout of one platform archive. `sourceDirMembers` is what tar and
 * zip receive relative to the platform build dir; README.md is archived from
 * outside that dir, so only `extractedMembers` — what the distribution manifest
 * promises and `extract-target.ts` asserts exactly — carries it. Both lists come
 * from here so a new archive member cannot reach one of them without the other.
 * // Usage: platformArchiveLayout('mangostudio')
 */
export function platformArchiveLayout(binaryName: ReleaseBinaryName): {
  readonly sourceDirMembers: string[];
  readonly extractedMembers: string[];
} {
  const sourceDirMembers = [binaryName, runtimeBinaryName(binaryName)];
  return { sourceDirMembers, extractedMembers: [...sourceDirMembers, 'README.md'] };
}

/** Return all release targets, or the one matching a platform/Bun target filter. // Usage: filterBinaryTargets('linux-x64') */
export function filterBinaryTargets(onlyPlatform?: string): BinaryTarget[] {
  if (!onlyPlatform) {
    return [...ALL_BINARY_TARGETS];
  }

  return ALL_BINARY_TARGETS.filter(
    (target) => target.arch === onlyPlatform || target.target === onlyPlatform
  );
}

/** Build the canonical release archive filename for one platform. // Usage: releaseArchiveFileName('1.2.3', target) */
export function releaseArchiveFileName(version: string, target: BinaryTarget): string {
  return `mangostudio-${version}-${target.arch}.${target.archiveFormat}`;
}

/**
 * Raw (uncompressed) hub binary asset name for one platform. Distinct from the
 * archive name so both can sit in SHA256SUMS without colliding.
 * // Usage: releaseRawHubBinaryFileName('1.2.3', target)
 */
export function releaseRawHubBinaryFileName(version: string, target: BinaryTarget): string {
  return target.name.endsWith('.exe')
    ? `mangostudio-${version}-${target.arch}.exe`
    : `mangostudio-${version}-${target.arch}`;
}

/**
 * Raw (uncompressed) runtime binary asset name for one platform.
 * // Usage: releaseRawRuntimeBinaryFileName('1.2.3', target)
 */
export function releaseRawRuntimeBinaryFileName(version: string, target: BinaryTarget): string {
  return target.name.endsWith('.exe')
    ? `mangostudio-runtime-${version}-${target.arch}.exe`
    : `mangostudio-runtime-${version}-${target.arch}`;
}
