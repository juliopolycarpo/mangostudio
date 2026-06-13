import { describe, expect, test } from 'bun:test';
import {
  buildMainManifest,
  buildOptionalDependencies,
  buildPlatformManifest,
  filterNpmPlatforms,
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

describe('filterNpmPlatforms', () => {
  test('returns every npm platform by default', () => {
    expect(filterNpmPlatforms()).toEqual(NPM_PLATFORMS);
  });

  test('limits npm package staging to one build target id', () => {
    expect(filterNpmPlatforms('linux-x64')).toEqual([LINUX_X64]);
  });

  test('rejects build targets that are not npm-distributable', () => {
    expect(() => filterNpmPlatforms('linux-x64-musl')).toThrow(/No npm platform matches filter/);
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

  test('includes public npm metadata', () => {
    const manifest = buildPlatformManifest(LINUX_X64, '1.2.3');
    expect(manifest.homepage).toBe('https://github.com/juliopolycarpo/mangostudio#readme');
    expect(manifest.bugs).toEqual({ url: 'https://github.com/juliopolycarpo/mangostudio/issues' });
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.engines).toEqual({ node: '>=18' });
    expect(manifest.keywords).toEqual(['mangostudio', 'ai', 'image-generation', 'chat', 'cli']);
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
