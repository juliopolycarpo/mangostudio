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
type ReleaseBinaryName = 'mangostudio' | 'mangostudio.exe';

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
