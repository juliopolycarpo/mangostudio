import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cursorNativePackageForArch, cursorSidecarPackageTreeErrors } from './cursor-sidecar';
import { fileError } from './fs-assert';
import {
  MAIN_PACKAGE,
  NPM_PLATFORMS,
  type NpmPlatform,
  platformPackageName,
  platformShipsCursorSidecar,
} from './npm-pack';
import type { ReleasePlatformId } from './release-targets';

interface ManifestReadResult {
  readonly errors: string[];
  readonly manifest?: Record<string, unknown>;
}

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

// The wrapper installs a platform binary purely through optionalDependencies, so
// a manifest missing them publishes cleanly yet leaves users with no binary.
const optionalDependencyErrors = (
  manifest: Record<string, unknown>,
  platforms: readonly NpmPlatform[]
): string[] => {
  const deps = manifest.optionalDependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    return ['Manifest optionalDependencies must be an object'];
  }

  const record = deps as Record<string, unknown>;
  return platforms.flatMap((platform) => {
    const name = platformPackageName(platform);
    const pinned = record[name];
    if (typeof pinned === 'string' && pinned.length > 0) {
      return [];
    }

    return [`Manifest optionalDependencies must pin ${name}`];
  });
};

const platformManifestErrors = (packageDir: string, platform: NpmPlatform): string[] => {
  const { errors: manifestReadErrors, manifest } = readManifest(join(packageDir, 'package.json'));
  if (!manifest) {
    return manifestReadErrors;
  }

  const errors = [
    ...manifestReadErrors,
    ...expectedStringError(manifest, 'name', platformPackageName(platform)),
    ...expectedVersionError(manifest),
    ...expectedArrayItemError(manifest, 'os', platform.os),
    ...expectedArrayItemError(manifest, 'cpu', platform.cpu),
    ...expectedArrayItemError(manifest, 'files', platform.binary),
    ...expectedArrayItemError(manifest, 'files', 'public'),
  ];
  if (platformShipsCursorSidecar(platform)) {
    errors.push(...expectedArrayItemError(manifest, 'files', 'cursor-sidecar'));
  }
  return errors;
};

const platformPackageErrors = (packageDir: string, platform: NpmPlatform): string[] => [
  ...fileError(join(packageDir, platform.binary), 'binary'),
  ...fileError(join(packageDir, 'public', 'index.html'), 'frontend index.html'),
  ...cursorSidecarErrors(packageDir, platform),
  ...platformManifestErrors(packageDir, platform),
];

function cursorSidecarErrors(packageDir: string, platform: NpmPlatform): string[] {
  const nativePackage = cursorNativePackageForArch(platform.arch as ReleasePlatformId);
  if (!nativePackage) return [];

  const sidecarDir = join(packageDir, 'cursor-sidecar');
  return [
    ...fileError(join(sidecarDir, 'run-agent.mjs'), 'Cursor sidecar script'),
    ...fileError(join(sidecarDir, 'sidecar-runtime.mjs'), 'Cursor sidecar runtime'),
    ...cursorSidecarPackageTreeErrors(sidecarDir, nativePackage),
  ];
}

/** Collect Cursor sidecar layout errors for a built platform directory.
 * Usage: collectCursorSidecarLayoutErrors('.mango/out/linux-x64', platform);
 */
export function collectCursorSidecarLayoutErrors(
  sourceDir: string,
  platform: NpmPlatform
): string[] {
  return cursorSidecarErrors(sourceDir, platform);
}

const assertNoErrors = (heading: string, errors: readonly string[]): void => {
  if (errors.length === 0) {
    return;
  }

  throw new Error(`${heading}:\n- ${errors.join('\n- ')}`);
};

const prefixedErrors = (prefix: string, errors: readonly string[]): string[] => {
  return errors.map((error) => `${prefix}: ${error}`);
};

const mainPackageErrors = (packageDir: string, platforms: readonly NpmPlatform[]): string[] => {
  const { errors, manifest } = readManifest(join(packageDir, 'package.json'));
  if (!manifest) {
    return errors;
  }

  return [
    ...errors,
    ...fileError(join(packageDir, 'bin', 'mangostudio.js'), 'CLI wrapper'),
    ...expectedStringError(manifest, 'name', MAIN_PACKAGE),
    ...expectedVersionError(manifest),
    ...optionalDependencyErrors(manifest, platforms),
  ];
};

/** Assert a built platform directory has the assets required for npm staging.
 * Usage: assertPlatformBuildAssets('.mango/out/linux-x64', platform);
 */
export function assertPlatformBuildAssets(sourceDir: string, platform: NpmPlatform): void {
  assertNoErrors(`Invalid build output for ${platform.arch}`, [
    ...fileError(join(sourceDir, platform.binary), 'binary'),
    ...fileError(join(sourceDir, 'public', 'index.html'), 'frontend index.html'),
    ...cursorSidecarErrors(sourceDir, platform),
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
    ...prefixedErrors(MAIN_PACKAGE, mainPackageErrors(join(distDir, 'cli'), platforms)),
  ]);
}
