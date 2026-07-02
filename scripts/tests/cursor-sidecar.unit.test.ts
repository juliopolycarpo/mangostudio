import { describe, expect, test } from 'bun:test';

import {
  createCursorSdkInstallCommand,
  cursorNativePackageFor,
  normalizeCursorSdkVersion,
} from '../lib/cursor-sidecar';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { readText } from './support/read-text';

describe('cursor sidecar native package mapping', () => {
  test('every release target resolves to a package name or an explicit null', () => {
    for (const target of ALL_BINARY_TARGETS) {
      const pkg = cursorNativePackageFor(target);
      expect(pkg === null || pkg.startsWith('@cursor/sdk-')).toBe(true);
    }
  });

  test('maps supported platforms to their Cursor native package', () => {
    const byArch = Object.fromEntries(
      ALL_BINARY_TARGETS.map((target) => [target.arch, cursorNativePackageFor(target)])
    );

    expect(byArch['linux-x64']).toBe('@cursor/sdk-linux-x64');
    expect(byArch['linux-arm64']).toBe('@cursor/sdk-linux-arm64');
    expect(byArch['darwin-x64']).toBe('@cursor/sdk-darwin-x64');
    expect(byArch['darwin-arm64']).toBe('@cursor/sdk-darwin-arm64');
    expect(byArch['windows-x64']).toBe('@cursor/sdk-win32-x64');
  });

  test('musl targets skip the Cursor sidecar', () => {
    const byArch = Object.fromEntries(
      ALL_BINARY_TARGETS.map((target) => [target.arch, cursorNativePackageFor(target)])
    );

    expect(byArch['linux-x64-musl']).toBeNull();
    expect(byArch['linux-arm64-musl']).toBeNull();
  });

  test('platforms without a Cursor runtime are skipped', () => {
    const winArm = ALL_BINARY_TARGETS.find((target) => target.arch === 'windows-arm64');
    expect(winArm).toBeDefined();
    if (winArm) expect(cursorNativePackageFor(winArm)).toBeNull();
  });
});

describe('cursor sidecar SDK staging', () => {
  test('installs all optional native packages through Bun', () => {
    expect(createCursorSdkInstallCommand('1.2.3')).toEqual([
      'bun',
      'install',
      '--no-save',
      '--ignore-scripts',
      '--os=*',
      '--cpu=*',
      '@cursor/sdk@1.2.3',
    ]);
  });

  test('normalizes manifest ranges to exact Cursor SDK versions', () => {
    expect(normalizeCursorSdkVersion('^1.0.22')).toBe('1.0.22');
    expect(normalizeCursorSdkVersion('~1.0.22-beta.1')).toBe('1.0.22-beta.1');
    expect(normalizeCursorSdkVersion('v1.0.22')).toBe('1.0.22');
  });

  test('rejects non-version Cursor SDK specs before package manager execution', () => {
    expect(() => normalizeCursorSdkVersion('latest')).toThrow(
      'Unsupported @cursor/sdk version spec'
    );
    expect(() => normalizeCursorSdkVersion('file:../cursor-sdk')).toThrow(
      'Unsupported @cursor/sdk version spec'
    );
  });

  test('avoids in-process registry tarball downloads', () => {
    const source = readText('scripts/lib/cursor-sidecar.ts');

    expect(source).not.toContain('await fetch(');
    expect(source).not.toContain('arrayBuffer()');
    expect(source).not.toContain("['tar', '-xzf'");
  });

  test('uses Node 22-compatible disposal and no hard-coded tool RPC timeout', () => {
    const source = readText('apps/api/src/services/providers/cursor/sidecar/run-agent.mjs');

    expect(source).not.toContain('await using');
    expect(source).not.toContain('TOOL_RPC_TIMEOUT_MS');
    expect(source).toContain('disposeAgent');
  });
});
