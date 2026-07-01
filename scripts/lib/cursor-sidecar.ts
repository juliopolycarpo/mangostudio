// Vendors the Cursor SDK Node sidecar and its runtime dependencies into a
// standalone build. The sidecar runs under the user's own Node.js (>= 22.13) —
// we never ship a Node binary — so it needs a real `node_modules` beside it:
//
//   <outdir>/cursor-sidecar/
//     run-agent.mjs
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
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from './config';
import { captureCommand } from './exec';
import { warn } from './log';
import type { BinaryTarget, ReleasePlatformId } from './release-targets';

const SIDECAR_SOURCE_DIR = join(ROOT_DIR, 'apps/api/src/services/providers/cursor/sidecar');
const CURSOR_SDK_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Maps each release target to the `@cursor/sdk-<platform>` package that carries
 * its native agent runtime. `null` means the Cursor SDK ships no runtime for
 * that platform, so the sidecar is skipped there rather than shipped broken.
 */
const CURSOR_NATIVE_PACKAGES: Record<ReleasePlatformId, string | null> = {
  'linux-x64': '@cursor/sdk-linux-x64',
  'linux-x64-musl': '@cursor/sdk-linux-x64',
  'linux-arm64': '@cursor/sdk-linux-arm64',
  'linux-arm64-musl': '@cursor/sdk-linux-arm64',
  'windows-x64': '@cursor/sdk-win32-x64',
  'windows-arm64': null,
  'darwin-x64': '@cursor/sdk-darwin-x64',
  'darwin-arm64': '@cursor/sdk-darwin-arm64',
};

export function cursorNativePackageForArch(arch: ReleasePlatformId): string | null {
  return CURSOR_NATIVE_PACKAGES[arch] ?? null;
}

export function cursorNativePackageFor(target: BinaryTarget): string | null {
  return cursorNativePackageForArch(target.arch);
}

export interface CursorSidecarStaging {
  /** node_modules holding the platform-independent SDK JS closure. */
  readonly jsClosureDir: string;
  /** node_modules holding the optional native packages keyed by package name. */
  readonly nativePackagesDir: string;
  readonly version: string;
  /** Removes the temporary staging tree. */
  cleanup(): void;
}

/** Reads the installed `@cursor/sdk` version so the vendored copy matches the lockfile. */
export function resolveCursorSdkVersion(): string {
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
    assertNativePackagesInstalled(jsClosureDir, targets);

    return { jsClosureDir, nativePackagesDir: jsClosureDir, version, cleanup };
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

  const missing = [...neededPackages].filter((pkg) => !existsSync(join(nodeModulesDir, pkg)));
  if (missing.length > 0) {
    throw new Error(`bun install did not stage Cursor native packages: ${missing.join(', ')}`);
  }
}

/** Excludes npm bin shims and native platform packages from the shared JS closure copy. */
function keepJsClosureEntry(src: string): boolean {
  const path = src.replaceAll('\\', '/');
  if (path.endsWith('/node_modules/.bin') || path.includes('/node_modules/.bin/')) return false;
  if (/\/@cursor\/sdk-[^/]+(\/|$)/.test(path)) return false;
  return true;
}
