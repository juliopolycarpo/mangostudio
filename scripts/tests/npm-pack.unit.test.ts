import { describe, expect, test } from 'bun:test';
import {
  buildMainManifest,
  buildOptionalDependencies,
  buildPlatformManifest,
  MAIN_PACKAGE,
  NPM_PLATFORMS,
  type NpmPlatform,
  platformPackageName,
} from '../lib/npm-pack';

const LINUX_X64: NpmPlatform = {
  arch: 'linux-x64',
  os: 'linux',
  cpu: 'x64',
  binary: 'mangostudio',
};
const WIN_ARM64: NpmPlatform = {
  arch: 'windows-arm64',
  os: 'win32',
  cpu: 'arm64',
  binary: 'mangostudio.exe',
};

describe('platformPackageName', () => {
  test('maps os/cpu to the scoped package name', () => {
    expect(platformPackageName(LINUX_X64)).toBe('@mangostudio/cli-linux-x64');
    expect(platformPackageName(WIN_ARM64)).toBe('@mangostudio/cli-win32-arm64');
  });
});

describe('NPM_PLATFORMS', () => {
  test('covers six targets with a consistent os→binary mapping', () => {
    expect(NPM_PLATFORMS).toHaveLength(6);
    for (const platform of NPM_PLATFORMS) {
      expect(['linux', 'darwin', 'win32']).toContain(platform.os);
      expect(['x64', 'arm64']).toContain(platform.cpu);
      expect(platform.binary).toBe(platform.os === 'win32' ? 'mangostudio.exe' : 'mangostudio');
    }
  });
});

describe('buildPlatformManifest', () => {
  test('gates the package by os + cpu and ships the binary + public sidecar', () => {
    const manifest = buildPlatformManifest(LINUX_X64, '1.2.3');
    expect(manifest.name).toBe('@mangostudio/cli-linux-x64');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.os).toEqual(['linux']);
    expect(manifest.cpu).toEqual(['x64']);
    expect(manifest.files).toEqual(['mangostudio', 'public']);
  });
});

describe('buildOptionalDependencies', () => {
  test('pins every platform package to the version', () => {
    const deps = buildOptionalDependencies('0.1.0');
    expect(Object.keys(deps)).toHaveLength(NPM_PLATFORMS.length);
    expect(deps['@mangostudio/cli-darwin-arm64']).toBe('0.1.0');
  });
});

describe('buildMainManifest', () => {
  test('preserves the base manifest and injects version + optionalDependencies', () => {
    const base = { name: MAIN_PACKAGE, bin: { mangostudio: 'bin/mangostudio.js' } };
    const manifest = buildMainManifest(base, '2.0.0');
    expect(manifest.name).toBe(MAIN_PACKAGE);
    expect(manifest.bin).toEqual({ mangostudio: 'bin/mangostudio.js' });
    expect(manifest.version).toBe('2.0.0');
    const optional = manifest.optionalDependencies as Record<string, string>;
    expect(optional['@mangostudio/cli-linux-x64']).toBe('2.0.0');
  });
});
