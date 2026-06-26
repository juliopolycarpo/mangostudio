import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMainManifest, buildPlatformManifest, type NpmPlatform } from '../lib/npm-pack';
import {
  assertNpmDistributionAssets,
  assertPlatformBuildAssets,
  assertPlatformPackageAssets,
} from '../lib/npm-package-validation';

const LINUX_X64: NpmPlatform = {
  arch: 'linux-x64',
  os: 'linux',
  cpu: 'x64',
  binary: 'mangostudio',
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
  writeJson(join(packageDir, 'package.json'), buildPlatformManifest(platform, '1.2.3'));
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
});

describe('assertPlatformPackageAssets', () => {
  test('accepts a complete staged platform package', () => {
    const packageDir = makeTempDir();
    writePlatformPackage(packageDir, LINUX_X64);

    expect(() => assertPlatformPackageAssets(packageDir, LINUX_X64)).not.toThrow();
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
