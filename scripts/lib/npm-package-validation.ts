import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAIN_PACKAGE, NPM_PLATFORMS, type NpmPlatform, platformPackageName } from './npm-pack';

interface ManifestReadResult {
  readonly errors: string[];
  readonly manifest?: Record<string, unknown>;
}

const missingFileError = (filePath: string, label: string): string[] => {
  if (!existsSync(filePath)) {
    return [`Missing ${label}: ${filePath}`];
  }

  if (statSync(filePath).isFile()) {
    return [];
  }

  return [`Expected ${label} to be a file: ${filePath}`];
};

const readManifest = (manifestPath: string): ManifestReadResult => {
  if (!existsSync(manifestPath)) {
    return { errors: [`Missing manifest: ${manifestPath}`] };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { errors: [`Manifest must be a JSON object: ${manifestPath}`] };
    }

    return { errors: [], manifest: manifest as Record<string, unknown> };
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
    return { errors: [`Invalid manifest JSON at ${manifestPath}: ${message}`] };
  }
};

const expectedStringError = (
  manifest: Record<string, unknown>,
  key: string,
  expected: string
): string[] => {
  if (manifest[key] === expected) {
    return [];
  }

  return [`Manifest ${key} must be ${expected}`];
};

const expectedArrayItemError = (
  manifest: Record<string, unknown>,
  key: string,
  expected: string
): string[] => {
  const value = manifest[key];
  if (Array.isArray(value) && value.includes(expected)) {
    return [];
  }

  return [`Manifest ${key} must include ${expected}`];
};

const expectedVersionError = (manifest: Record<string, unknown>): string[] => {
  if (typeof manifest.version === 'string' && manifest.version.length > 0) {
    return [];
  }

  return ['Manifest version must be a non-empty string'];
};

const platformManifestErrors = (packageDir: string, platform: NpmPlatform): string[] => {
  const { errors, manifest } = readManifest(join(packageDir, 'package.json'));
  if (!manifest) {
    return errors;
  }

  return [
    ...errors,
    ...expectedStringError(manifest, 'name', platformPackageName(platform)),
    ...expectedVersionError(manifest),
    ...expectedArrayItemError(manifest, 'os', platform.os),
    ...expectedArrayItemError(manifest, 'cpu', platform.cpu),
    ...expectedArrayItemError(manifest, 'files', platform.binary),
    ...expectedArrayItemError(manifest, 'files', 'public'),
  ];
};

const platformPackageErrors = (packageDir: string, platform: NpmPlatform): string[] => [
  ...missingFileError(join(packageDir, platform.binary), 'binary'),
  ...missingFileError(join(packageDir, 'public', 'index.html'), 'frontend index.html'),
  ...platformManifestErrors(packageDir, platform),
];

const assertNoErrors = (heading: string, errors: readonly string[]): void => {
  if (errors.length === 0) {
    return;
  }

  throw new Error(`${heading}:\n- ${errors.join('\n- ')}`);
};

const prefixedErrors = (prefix: string, errors: readonly string[]): string[] => {
  return errors.map((error) => `${prefix}: ${error}`);
};

const mainPackageErrors = (packageDir: string): string[] => {
  const { errors, manifest } = readManifest(join(packageDir, 'package.json'));
  if (!manifest) {
    return errors;
  }

  return [
    ...errors,
    ...missingFileError(join(packageDir, 'bin', 'mangostudio.js'), 'CLI wrapper'),
    ...expectedStringError(manifest, 'name', MAIN_PACKAGE),
    ...expectedVersionError(manifest),
  ];
};

/** Assert a built platform directory has the assets required for npm staging.
 * Usage: assertPlatformBuildAssets('.mango/out/linux-x64', platform);
 */
export function assertPlatformBuildAssets(sourceDir: string, platform: NpmPlatform): void {
  assertNoErrors(`Invalid build output for ${platform.arch}`, [
    ...missingFileError(join(sourceDir, platform.binary), 'binary'),
    ...missingFileError(join(sourceDir, 'public', 'index.html'), 'frontend index.html'),
  ]);
}

/** Assert a staged platform package has publishable runtime assets and manifest.
 * Usage: assertPlatformPackageAssets('dist-npm/linux-x64', platform);
 */
export function assertPlatformPackageAssets(packageDir: string, platform: NpmPlatform): void {
  assertNoErrors(`Invalid npm package for ${platformPackageName(platform)}`, [
    ...platformPackageErrors(packageDir, platform),
  ]);
}

/** Assert a staged npm distribution is complete enough to publish.
 * Usage: assertNpmDistributionAssets('dist-npm');
 */
export function assertNpmDistributionAssets(
  distDir: string,
  platforms: readonly NpmPlatform[] = NPM_PLATFORMS
): void {
  const errors = platforms.flatMap((platform) => {
    const packageDir = join(distDir, `${platform.os}-${platform.cpu}`);
    return prefixedErrors(
      platformPackageName(platform),
      platformPackageErrors(packageDir, platform)
    );
  });

  assertNoErrors(`Invalid npm distribution at ${distDir}`, [
    ...errors,
    ...prefixedErrors(MAIN_PACKAGE, mainPackageErrors(join(distDir, 'cli'))),
  ]);
}
