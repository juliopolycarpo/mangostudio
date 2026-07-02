import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorNativePackageForArch } from '../lib/cursor-sidecar';
import { buildMainManifest, buildPlatformManifest, type NpmPlatform } from '../lib/npm-pack';
import {
  assertNpmDistributionAssets,
  assertPlatformBuildAssets,
  assertPlatformPackageAssets,
  collectCursorSidecarLayoutErrors,
} from '../lib/npm-package-validation';
import type { ReleasePlatformId } from '../lib/release-targets';

const LINUX_X64: NpmPlatform = {
  arch: 'linux-x64',
  os: 'linux',
  cpu: 'x64',
  binary: 'mangostudio',
};

const WINDOWS_ARM64: NpmPlatform = {
  arch: 'windows-arm64',
  os: 'win32',
  cpu: 'arm64',
  binary: 'mangostudio.exe',
};

let tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-npm-pack-'));
  tempDirs.push(dir);
  return dir;
};

const writeJson = (filePath: string, value: Record<string, unknown>): void => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writePlatformPackage = (packageDir: string, platform: NpmPlatform): void => {
  mkdirSync(join(packageDir, 'public'), { recursive: true });
  writeFileSync(join(packageDir, platform.binary), 'binary');
  writeFileSync(join(packageDir, 'public', 'index.html'), '<!doctype html>');
  writeCursorSidecar(packageDir, platform);
  writeJson(join(packageDir, 'package.json'), buildPlatformManifest(platform, '1.2.3'));
};

const writeCursorSidecar = (packageDir: string, platform: NpmPlatform): void => {
  const nativePackage = cursorNativePackageForArch(platform.arch as ReleasePlatformId);
  if (!nativePackage) return;

  const sidecarDir = join(packageDir, 'cursor-sidecar');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(join(sidecarDir, 'run-agent.mjs'), '#!/usr/bin/env node');
  mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk'), { recursive: true });
  writeJson(join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'package.json'), {
    name: '@cursor/sdk',
  });
  mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'dist', 'cjs'), {
    recursive: true,
  });
  mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'dist', 'esm'), {
    recursive: true,
  });
  writeFileSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'dist', 'cjs', '642.js'), '');
  writeFileSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'dist', 'esm', '642.js'), '');
  mkdirSync(join(sidecarDir, 'node_modules', nativePackage), { recursive: true });
  writeJson(join(sidecarDir, 'node_modules', nativePackage, 'package.json'), {
    name: nativePackage,
    bin: { rg: 'bin/rg' },
  });
  mkdirSync(join(sidecarDir, 'node_modules', nativePackage, 'bin'), { recursive: true });
  writeFileSync(join(sidecarDir, 'node_modules', nativePackage, 'bin', 'rg'), 'rg');
};

const writeMainPackage = (packageDir: string): void => {
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(join(packageDir, 'bin', 'mangostudio.js'), '#!/usr/bin/env node');
  writeJson(
    join(packageDir, 'package.json'),
    buildMainManifest({ name: 'mangostudio' }, '1.2.3', [LINUX_X64])
  );
};

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }

  tempDirs = [];
});

describe('assertPlatformBuildAssets', () => {
  test('rejects build output with a missing platform binary', () => {
    const sourceDir = makeTempDir();
    mkdirSync(join(sourceDir, 'public'), { recursive: true });
    writeFileSync(join(sourceDir, 'public', 'index.html'), '<!doctype html>');

    expect(() => assertPlatformBuildAssets(sourceDir, LINUX_X64)).toThrow(/Missing binary/);
  });

  test('rejects build output with a missing frontend sidecar', () => {
    const sourceDir = makeTempDir();
    writeFileSync(join(sourceDir, LINUX_X64.binary), 'binary');

    expect(() => assertPlatformBuildAssets(sourceDir, LINUX_X64)).toThrow(
      /Missing frontend index\.html/
    );
  });

  test('rejects build output with a missing Cursor sidecar', () => {
    const sourceDir = makeTempDir();
    mkdirSync(join(sourceDir, 'public'), { recursive: true });
    writeFileSync(join(sourceDir, LINUX_X64.binary), 'binary');
    writeFileSync(join(sourceDir, 'public', 'index.html'), '<!doctype html>');

    expect(() => assertPlatformBuildAssets(sourceDir, LINUX_X64)).toThrow(
      /Missing Cursor sidecar script/
    );
  });
});

describe('collectCursorSidecarLayoutErrors', () => {
  test('rejects a Cursor sidecar tree that is missing numbered SDK chunks', () => {
    const sourceDir = makeTempDir();
    writePlatformPackage(sourceDir, LINUX_X64);
    rmSync(join(sourceDir, 'cursor-sidecar', 'node_modules', '@cursor', 'sdk', 'dist', 'cjs'), {
      recursive: true,
      force: true,
    });

    const errors = collectCursorSidecarLayoutErrors(sourceDir, LINUX_X64);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.includes('cjs'))).toBe(true);
  });
});

describe('assertPlatformPackageAssets', () => {
  test('accepts a complete staged platform package', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).not.toThrow();
  });

  test('accepts a platform package without a Cursor native runtime', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, WINDOWS_ARM64);

    expect(() => assertPlatformPackageAssets(packageDir, WINDOWS_ARM64)).not.toThrow();
  });

  test('rejects a package manifest that omits the frontend sidecar', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);
    writeJson(join(packageDir, 'package.json'), {
      ...buildPlatformManifest(LINUX_X64, '1.2.3'),
      files: [LINUX_X64.binary],
    });

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).toThrow(
      /Manifest files must include public/
    );
  });

  test('rejects a package manifest that omits the Cursor sidecar', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);
    writeJson(join(packageDir, 'package.json'), {
      ...buildPlatformManifest(LINUX_X64, '1.2.3'),
      files: [LINUX_X64.binary, 'public'],
    });

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).toThrow(
      /Manifest files must include cursor-sidecar/
    );
  });

  test('rejects a staged platform package with a missing Cursor sidecar', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);
    rmSync(join(packageDir, 'cursor-sidecar', 'run-agent.mjs'));

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).toThrow(
      /Missing Cursor sidecar script/
    );
  });

  test('rejects a staged platform package with missing Cursor SDK chunks', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);
    rmSync(
      join(packageDir, 'cursor-sidecar', 'node_modules', '@cursor', 'sdk', 'dist', 'cjs', '642.js')
    );

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).toThrow(
      /Missing Cursor SDK cjs numbered chunks/
    );
  });

  test('rejects a staged platform package with a missing Cursor native binary', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);
    const nativePackage = cursorNativePackageForArch(LINUX_X64.arch as ReleasePlatformId);
    expect(nativePackage).toBeTruthy();
    if (!nativePackage) return;
    rmSync(join(packageDir, 'cursor-sidecar', 'node_modules', nativePackage, 'bin', 'rg'));

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).toThrow(
      /Missing Cursor native package .* package entrypoint/
    );
  });
});

describe('assertNpmDistributionAssets', () => {
  test('rejects a staged distribution with a missing platform binary', () => {
    const distDir = makeTempDir();
    const packageDir = join(distDir, `${LINUX_X64.os}-${LINUX_X64.cpu}`);
    writePlatformPackage(packageDir, LINUX_X64);
    rmSync(join(packageDir, LINUX_X64.binary));
    writeMainPackage(join(distDir, 'cli'));

    expect(() => assertNpmDistributionAssets(distDir, [LINUX_X64])).toThrow(/Missing binary/);
  });

  test('rejects a staged distribution with a missing frontend sidecar', () => {
    const distDir = makeTempDir();
    const packageDir = join(distDir, `${LINUX_X64.os}-${LINUX_X64.cpu}`);
    writePlatformPackage(packageDir, LINUX_X64);
    rmSync(join(packageDir, 'public', 'index.html'));
    writeMainPackage(join(distDir, 'cli'));

    expect(() => assertNpmDistributionAssets(distDir, [LINUX_X64])).toThrow(
      /Missing frontend index\.html/
    );
  });

  test('rejects a wrapper whose optionalDependencies omit a platform package', () => {
    const distDir = makeTempDir();
    const packageDir = join(distDir, `${LINUX_X64.os}-${LINUX_X64.cpu}`);
    writePlatformPackage(packageDir, LINUX_X64);
    const cliDir = join(distDir, 'cli');
    writeMainPackage(cliDir);
    writeJson(join(cliDir, 'package.json'), {
      name: 'mangostudio',
      version: '1.2.3',
      optionalDependencies: {},
    });

    expect(() => assertNpmDistributionAssets(distDir, [LINUX_X64])).toThrow(
      /optionalDependencies must pin @mangostudio\/cli-linux-x64/
    );
  });
});
