// Pure helpers for assembling the npm distribution: platform descriptors, the
// per-platform package manifests, and the main package's optional dependencies.
// scripts/release/pack-npm.ts wires these to the filesystem.

import { cursorNativePackageForArch } from './cursor-sidecar';
import type { ReleasePlatformId } from './release-targets';

const CLI_SCOPE = '@mangostudio';
export const MAIN_PACKAGE = 'mangostudio';
const PLATFORM_PACKAGE_PREFIX = `${CLI_SCOPE}/cli`;
const REPOSITORY_URL = 'git+https://github.com/juliopolycarpo/mangostudio.git';
const HOMEPAGE_URL = 'https://mangostudio.dev';
const BUGS_URL = 'https://github.com/juliopolycarpo/mangostudio/issues';
const PACKAGE_KEYWORDS = ['mangostudio', 'ai', 'image-generation', 'chat', 'cli'];
const NODE_ENGINES = { node: '>=18' };
const PUBLIC_PUBLISH_CONFIG = { access: 'public' };

export interface NpmPlatform {
  /** build.ts output directory under .mango/out. */
  readonly arch: string;
  /** Node process.platform value used for the package name + os field. */
  readonly os: 'linux' | 'darwin' | 'win32';
  /** Node process.arch value used for the package name + cpu field. */
  readonly cpu: 'x64' | 'arm64';
  /** Binary filename inside the platform directory. */
  readonly binary: 'mangostudio' | 'mangostudio.exe';
}

// The npm-distributable subset of build.ts targets (musl is download-only).
export const NPM_PLATFORMS: readonly NpmPlatform[] = [
  { arch: 'linux-x64', os: 'linux', cpu: 'x64', binary: 'mangostudio' },
  { arch: 'linux-arm64', os: 'linux', cpu: 'arm64', binary: 'mangostudio' },
  { arch: 'darwin-x64', os: 'darwin', cpu: 'x64', binary: 'mangostudio' },
  { arch: 'darwin-arm64', os: 'darwin', cpu: 'arm64', binary: 'mangostudio' },
  { arch: 'windows-x64', os: 'win32', cpu: 'x64', binary: 'mangostudio.exe' },
  { arch: 'windows-arm64', os: 'win32', cpu: 'arm64', binary: 'mangostudio.exe' },
];

/** Select npm-distributable platform packages, optionally limited by build target id. */
export function filterNpmPlatforms(onlyPlatform?: string): readonly NpmPlatform[] {
  if (!onlyPlatform) {
    return NPM_PLATFORMS;
  }

  const platforms = NPM_PLATFORMS.filter((platform) => platform.arch === onlyPlatform);
  if (platforms.length === 0) {
    throw new Error(
      `No npm platform matches filter: ${onlyPlatform}. Available platforms: ${NPM_PLATFORMS.map((platform) => platform.arch).join(', ')}`
    );
  }
  return platforms;
}

/** Scoped npm package name for a platform, e.g. @mangostudio/cli-linux-x64. */
export function platformPackageName(platform: NpmPlatform): string {
  return `${PLATFORM_PACKAGE_PREFIX}-${platform.os}-${platform.cpu}`;
}

/** True when the platform ships a vendored Cursor SDK sidecar beside the binary. */
export function platformShipsCursorSidecar(platform: NpmPlatform): boolean {
  return cursorNativePackageForArch(platform.arch as ReleasePlatformId) !== null;
}

/** package.json for a per-platform binary package, gated by os + cpu. */
export function buildPlatformManifest(
  platform: NpmPlatform,
  version: string
): Record<string, unknown> {
  const files = [platform.binary];
  if (platformShipsCursorSidecar(platform)) {
    files.push('cursor-sidecar');
  }

  return {
    name: platformPackageName(platform),
    version,
    description: `MangoStudio prebuilt binary for ${platform.os}-${platform.cpu}.`,
    license: 'MIT',
    repository: { type: 'git', url: REPOSITORY_URL, directory: 'packages/cli' },
    homepage: HOMEPAGE_URL,
    bugs: { url: BUGS_URL },
    publishConfig: PUBLIC_PUBLISH_CONFIG,
    engines: NODE_ENGINES,
    keywords: PACKAGE_KEYWORDS,
    os: [platform.os],
    cpu: [platform.cpu],
    files,
  };
}

/** optionalDependencies mapping every platform package to the release version. */
export function buildOptionalDependencies(
  version: string,
  platforms: readonly NpmPlatform[] = NPM_PLATFORMS
): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const platform of platforms) {
    deps[platformPackageName(platform)] = version;
  }
  return deps;
}

/** Main package manifest: the committed base plus version + optionalDependencies. */
export function buildMainManifest(
  baseManifest: Record<string, unknown>,
  version: string,
  platforms: readonly NpmPlatform[] = NPM_PLATFORMS
): Record<string, unknown> {
  return {
    ...baseManifest,
    version,
    optionalDependencies: buildOptionalDependencies(version, platforms),
  };
}
