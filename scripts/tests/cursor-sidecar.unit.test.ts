import { describe, expect, test } from 'bun:test';

import { cursorNativePackageFor } from '../lib/cursor-sidecar';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';

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

  test('musl targets reuse the glibc linux native package', () => {
    const byArch = Object.fromEntries(
      ALL_BINARY_TARGETS.map((target) => [target.arch, cursorNativePackageFor(target)])
    );

    expect(byArch['linux-x64-musl']).toBe('@cursor/sdk-linux-x64');
    expect(byArch['linux-arm64-musl']).toBe('@cursor/sdk-linux-arm64');
  });

  test('platforms without a Cursor runtime are skipped', () => {
    const winArm = ALL_BINARY_TARGETS.find((target) => target.arch === 'windows-arm64');
    expect(winArm).toBeDefined();
    if (winArm) expect(cursorNativePackageFor(winArm)).toBeNull();
  });
});
