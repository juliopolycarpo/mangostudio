// Vendors the Cursor SDK Node sidecar and its runtime dependencies into a
// standalone build. The sidecar runs under the user's own Node.js (>= 22.13) —
// we never ship a Node binary — so it needs a real `node_modules` beside it:
//
//   <outdir>/cursor-sidecar/
//     run-agent.mjs
//     sidecar-runtime.mjs
//     node_modules/@cursor/sdk            (platform-independent JS)
//     node_modules/@cursor/sdk-<platform> (native agent + ripgrep binaries)
//     node_modules/<js deps…>
//
// `@cursor/sdk` cannot be bundled: its dist loads chunks via dynamic
// `require('./NNN.js')` and resolves its native runtime through
// `createRequire(import.meta.url)`, so both need the real package tree on disk.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Release and smoke scripts run without `bun install`; the package catalog
// barrel re-exports schemas that pull in @sinclair/typebox.
import {
  CURSOR_NATIVE_PACKAGES,
  cursorNativePackageForPlatform,
  isCursorSdkChunkFileName,
} from '../../apps/shared/src/catalog/cursor-native-packages';
import { ROOT_DIR } from './config';
import { captureCommand } from './exec';
import { warn } from './log';
import type { BinaryTarget, ReleasePlatformId } from './release-targets';

const SIDECAR_SOURCE_DIR = join(ROOT_DIR, 'apps/api/src/services/providers/cursor/sidecar');
const CURSOR_SDK_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CURSOR_SDK_PACKAGE_SEGMENTS = ['@cursor', 'sdk'] as const;
const CURSOR_SDK_DIST_FLAVORS = ['cjs', 'esm'] as const;

export { CURSOR_NATIVE_PACKAGES };

export interface CursorSdkChunkManifest {
  readonly cjs: readonly string[];
  readonly esm: readonly string[];
}

export function cursorNativePackageForArch(arch: ReleasePlatformId): string | null {
  return cursorNativePackageForPlatform(arch);
}

export function cursorNativePackageFor(target: BinaryTarget): string | null {
  return cursorNativePackageForArch(target.arch);
}

export interface CursorSidecarStaging {
  /** node_modules holding the platform-independent SDK JS closure. */
  readonly jsClosureDir: string;
  /** node_modules holding the optional native packages keyed by package name. */
  readonly nativePackagesDir: string;
  /** Dynamic SDK chunks recorded from the staged install. */
  readonly sdkChunks: CursorSdkChunkManifest;
  readonly version: string;
  /** Removes the temporary staging tree. */
  cleanup(): void;
}

/** Reads the installed `@cursor/sdk` version so the vendored copy matches the lockfile. */
function resolveCursorSdkVersion(): string {
  const installed = join(ROOT_DIR, 'apps/api/node_modules/@cursor/sdk/package.json');
  if (existsSync(installed)) {
    const pkg = JSON.parse(readFileSync(installed, 'utf8')) as { version?: string };
    if (pkg.version) return normalizeCursorSdkVersion(pkg.version);
  }

  const apiPkg = JSON.parse(readFileSync(join(ROOT_DIR, 'apps/api/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const spec = apiPkg.dependencies?.['@cursor/sdk'];
  if (!spec) throw new Error('@cursor/sdk is not declared in apps/api/package.json');
  return normalizeCursorSdkVersion(spec);
}

export function normalizeCursorSdkVersion(spec: string): string {
  const version = spec.trim().replace(/^[~^=v]*/, '');
  if (!CURSOR_SDK_VERSION_PATTERN.test(version)) {
    throw new Error(`Unsupported @cursor/sdk version spec: ${spec}`);
  }
  return version;
}

export function createCursorSdkInstallCommand(version: string): string[] {
  return [
    'bun',
    'install',
    '--no-save',
    '--ignore-scripts',
    '--os=*',
    '--cpu=*',
    `@cursor/sdk@${normalizeCursorSdkVersion(version)}`,
  ];
}

/**
 * Builds the platform-independent SDK closure once and prefetches every native
 * package the given targets need. Returns `null` (with a warning) if staging
 * fails, so a broken Cursor vendor never fails the whole binary build.
 */
export async function prepareCursorSidecarStaging(
  targets: BinaryTarget[]
): Promise<CursorSidecarStaging | null> {
  if (!existsSync(SIDECAR_SOURCE_DIR)) return null;

  let version: string;
  try {
    version = resolveCursorSdkVersion();
  } catch (error) {
    warn(`Skipping Cursor sidecar vendoring: ${error instanceof Error ? error.message : error}`);
    return null;
  }

  const root = mkdtempSync(join(tmpdir(), 'mango-cursor-sidecar-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  try {
    const jsClosureDir = await installJsClosure(root, version);
    const sdkErrors = cursorSdkPackageTreeErrors(jsClosureDir);
    if (sdkErrors.length > 0) {
      throw new Error(`bun install staged an incomplete Cursor SDK:\n- ${sdkErrors.join('\n- ')}`);
    }
    const sdkChunks = collectCursorSdkChunks(cursorSdkPackageDir(jsClosureDir));
    assertNativePackagesInstalled(jsClosureDir, targets);

    return { jsClosureDir, nativePackagesDir: jsClosureDir, sdkChunks, version, cleanup };
  } catch (error) {
    warn(`Skipping Cursor sidecar vendoring: ${error instanceof Error ? error.message : error}`);
    cleanup();
    return null;
  }
}

/**
 * Copies the sidecar entrypoint plus its resolved dependency tree (JS closure +
 * the target's native package) into `destSidecarDir`. Returns `false` when the
 * target has no Cursor runtime and the sidecar was intentionally skipped.
 */
export function assembleCursorSidecar(
  destSidecarDir: string,
  target: BinaryTarget,
  staging: CursorSidecarStaging
): boolean {
  const nativePackage = cursorNativePackageFor(target);
  if (!nativePackage) return false;

  const cachedNative = join(staging.nativePackagesDir, nativePackage);
  if (!existsSync(cachedNative)) return false;

  mkdirSync(destSidecarDir, { recursive: true });
  cpSync(SIDECAR_SOURCE_DIR, destSidecarDir, { recursive: true });

  const destNodeModules = join(destSidecarDir, 'node_modules');
  cpSync(staging.jsClosureDir, destNodeModules, {
    recursive: true,
    dereference: true,
    filter: keepJsClosureEntry,
  });
  cpSync(cachedNative, join(destNodeModules, nativePackage), { recursive: true });

  const errors = cursorSidecarPackageTreeErrors(destSidecarDir, nativePackage, staging.sdkChunks);
  if (errors.length > 0) {
    throw new Error(`Assembled Cursor sidecar is incomplete:\n- ${errors.join('\n- ')}`);
  }

  return true;
}

async function installJsClosure(root: string, version: string): Promise<string> {
  const installDir = join(root, 'install');
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cursor-sidecar-deps',
        private: true,
        type: 'module',
        dependencies: { '@cursor/sdk': version },
      },
      null,
      2
    )}\n`
  );

  const { exitCode, stderr, stdout } = await captureCommand(
    createCursorSdkInstallCommand(version),
    {
      cwd: installDir,
    }
  );
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(`bun install for the Cursor sidecar failed: ${detail}`);
  }

  return join(installDir, 'node_modules');
}

function assertNativePackagesInstalled(nodeModulesDir: string, targets: BinaryTarget[]): void {
  const neededPackages = new Set<string>();
  for (const target of targets) {
    const pkg = cursorNativePackageFor(target);
    if (pkg) neededPackages.add(pkg);
  }

  const errors = [...neededPackages].flatMap((pkg) =>
    cursorNativePackageTreeErrors(nodeModulesDir, pkg)
  );
  if (errors.length > 0) {
    throw new Error(`bun install did not stage Cursor native packages:\n- ${errors.join('\n- ')}`);
  }
}

function cursorSdkPackageDir(nodeModulesDir: string): string {
  return join(nodeModulesDir, ...CURSOR_SDK_PACKAGE_SEGMENTS);
}

function packageDir(nodeModulesDir: string, packageName: string): string {
  return join(nodeModulesDir, ...packageName.split('/'));
}

function listCursorSdkChunks(distDir: string): string[] {
  try {
    return readdirSync(distDir).filter(isCursorSdkChunkFileName).sort();
  } catch {
    return [];
  }
}

export function collectCursorSdkChunks(sdkPackageDir: string): CursorSdkChunkManifest {
  return {
    cjs: listCursorSdkChunks(join(sdkPackageDir, 'dist', 'cjs')),
    esm: listCursorSdkChunks(join(sdkPackageDir, 'dist', 'esm')),
  };
}

function cursorSdkChunkErrors(
  sdkPackageDir: string,
  expectedChunks?: CursorSdkChunkManifest
): string[] {
  const errors: string[] = [];

  for (const flavor of CURSOR_SDK_DIST_FLAVORS) {
    const distDir = join(sdkPackageDir, 'dist', flavor);
    if (!existsSync(distDir)) {
      errors.push(`Missing Cursor SDK ${flavor} chunk directory: ${distDir}`);
      continue;
    }

    const chunks = listCursorSdkChunks(distDir);
    if (chunks.length === 0) {
      errors.push(`Missing Cursor SDK ${flavor} numbered chunks in ${distDir}`);
      continue;
    }

    const expected = expectedChunks?.[flavor];
    if (!expected) continue;

    const missing = expected.filter((chunk) => !chunks.includes(chunk));
    const extra = chunks.filter((chunk) => !expected.includes(chunk));
    if (missing.length > 0 || extra.length > 0) {
      errors.push(
        `Cursor SDK ${flavor} chunks differ from staged install: missing [${missing.join(', ') || 'none'}], extra [${extra.join(', ') || 'none'}]`
      );
    }
  }

  return errors;
}

interface PackageManifestReadResult {
  readonly errors: string[];
  readonly manifest?: Record<string, unknown>;
}

function readPackageManifest(packageDir: string, label: string): PackageManifestReadResult {
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    return { errors: [`Missing ${label} package: ${manifestPath}`] };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { errors: [`${label} package manifest must be a JSON object: ${manifestPath}`] };
    }
    return { errors: [], manifest: manifest as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`Invalid ${label} package manifest at ${manifestPath}: ${message}`] };
  }
}

function declaredPackageEntrypoints(manifest: Record<string, unknown>): string[] {
  const entrypoints = new Set<string>();
  if (typeof manifest.main === 'string' && manifest.main.length > 0) {
    entrypoints.add(manifest.main);
  }

  if (typeof manifest.bin === 'string' && manifest.bin.length > 0) {
    entrypoints.add(manifest.bin);
  } else if (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === 'string' && value.length > 0) entrypoints.add(value);
    }
  }

  return [...entrypoints];
}

function packageDeclaredEntrypointErrors(packageDir: string, label: string): string[] {
  const { errors, manifest } = readPackageManifest(packageDir, label);
  if (!manifest) return errors;

  return [
    ...errors,
    ...declaredPackageEntrypoints(manifest).flatMap((entrypoint) => {
      const path = join(packageDir, entrypoint);
      return existsSync(path) ? [] : [`Missing ${label} package entrypoint: ${path}`];
    }),
  ];
}

export function cursorSdkPackageTreeErrors(
  nodeModulesDir: string,
  expectedChunks?: CursorSdkChunkManifest
): string[] {
  const sdkDir = cursorSdkPackageDir(nodeModulesDir);
  return [
    ...readPackageManifest(sdkDir, 'Cursor SDK').errors,
    ...cursorSdkChunkErrors(sdkDir, expectedChunks),
  ];
}

function cursorNativePackageTreeErrors(nodeModulesDir: string, nativePackage: string): string[] {
  return packageDeclaredEntrypointErrors(
    packageDir(nodeModulesDir, nativePackage),
    `Cursor native package ${nativePackage}`
  );
}

export function cursorSidecarPackageTreeErrors(
  sidecarDir: string,
  nativePackage: string,
  expectedChunks?: CursorSdkChunkManifest
): string[] {
  const nodeModulesDir = join(sidecarDir, 'node_modules');
  return [
    ...cursorSdkPackageTreeErrors(nodeModulesDir, expectedChunks),
    ...cursorNativePackageTreeErrors(nodeModulesDir, nativePackage),
  ];
}

/** Excludes npm bin shims and native platform packages from the shared JS closure copy. */
function keepJsClosureEntry(src: string): boolean {
  const path = src.replaceAll('\\', '/');
  if (path.endsWith('/node_modules/.bin') || path.includes('/node_modules/.bin/')) return false;
  if (/\/@cursor\/sdk-[^/]+(\/|$)/.test(path)) return false;
  return true;
}
