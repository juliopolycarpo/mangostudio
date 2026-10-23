import { describe, expect, test } from 'bun:test';
import { assertNoRegistryBunPackages, type BunDependencyLock } from '../lib/bun-peer-policy';
import { readText } from './support/read-text';

describe('Bun peer lockfile policy', () => {
  test('the real lockfile contains no registry Bun runtime', () => {
    const lock = Bun.JSON5.parse(readText('bun.lock')) as BunDependencyLock;
    expect(() => assertNoRegistryBunPackages(lock)).not.toThrow();
  });

  test('a bun-types override, while one exists, names the pinned Bun', () => {
    // The override is a stopgap for the days `@types/bun` trails a Bun release.
    // Left behind by a later bump it would force older types under a newer
    // wrapper, and nothing else in the repository would notice.
    const root = JSON.parse(readText('package.json')) as {
      overrides?: Record<string, string>;
    };
    const lock = Bun.JSON5.parse(readText('bun.lock')) as BunDependencyLock;
    const pinned = readText('.bun-version').trim();
    const override = root.overrides?.['bun-types'];
    const locked = lock.overrides?.['bun-types'];

    expect(
      locked,
      `expected bun.lock overrides["bun-types"]: ${override} | received: ${locked}`
    ).toBe(override);
    if (override === undefined) return;
    expect(
      override,
      `expected overrides["bun-types"]: ${pinned} (.bun-version) | received: ${override}`
    ).toBe(pinned);
  });

  test('runtime imports still resolve to the host Bun builtin', async () => {
    const hostBun = await import('bun');
    expect(hostBun.version).toBe(Bun.version);
    expect(hostBun.build).toBe(Bun.build);
  });

  test('names the plugin peer that brings back registry Bun', () => {
    expect(() =>
      assertNoRegistryBunPackages({
        packages: {
          'bun-plugin-tailwind': [
            'bun-plugin-tailwind@0.1.2',
            '',
            { peerDependencies: { bun: '>=1.0.0' } },
          ],
          bun: ['bun@1.4.0', '', {}],
        },
      })
    ).toThrow(
      'bun: bun@1.4.0, required by bun-plugin-tailwind@0.1.2 peerDependencies.bun (>=1.0.0)'
    );
  });

  test('detects an aliased registry runtime and its workspace importer', () => {
    expect(() =>
      assertNoRegistryBunPackages({
        workspaces: {
          'apps/frontend': { devDependencies: { runtime: 'npm:bun@1.4.0' } },
        },
        packages: { runtime: ['bun@1.4.0', '', {}] },
      })
    ).toThrow(
      'runtime: bun@1.4.0, required by apps/frontend/package.json devDependencies.runtime (npm:bun@1.4.0)'
    );
  });

  test('detects native binaries in any lockfile location and names the optional importer', () => {
    expect(() =>
      assertNoRegistryBunPackages({
        packages: {
          wrapper: [
            'wrapper@1.0.0',
            '',
            { optionalDependencies: { '@oven/bun-linux-x64': '1.4.0' } },
          ],
          'wrapper/@oven/bun-linux-x64': ['@oven/bun-linux-x64@1.4.0', '', {}],
        },
      })
    ).toThrow(
      'wrapper/@oven/bun-linux-x64: @oven/bun-linux-x64@1.4.0, required by wrapper@1.0.0 optionalDependencies.@oven/bun-linux-x64 (1.4.0)'
    );
  });

  test('detects an orphan runtime and states the permitted shape', () => {
    expect(() => assertNoRegistryBunPackages({ packages: { bun: ['bun@1.4.0', '', {}] } })).toThrow(
      'expected the externally installed toolchain with no Bun runtime packages'
    );
    expect(() => assertNoRegistryBunPackages({ packages: { bun: ['bun@1.4.0', '', {}] } })).toThrow(
      'bun: bun@1.4.0, required by no declaring importer in bun.lock'
    );
  });

  test('rejects a different file source instead of treating every local Bun as safe', () => {
    expect(() =>
      assertNoRegistryBunPackages({
        packages: { 'bun-plugin-tailwind/bun': ['bun@file:./other-runtime', {}] },
      })
    ).toThrow('bun-plugin-tailwind/bun: bun@file:./other-runtime');
  });

  test('rejects extra dependencies or binary metadata in the permitted file source', () => {
    for (const metadata of [{ dependencies: { bun: '1.4.0' } }, { bin: { bun: 'bun.exe' } }, []]) {
      expect(() =>
        assertNoRegistryBunPackages({
          packages: { 'bun-plugin-tailwind/bun': ['bun@file:./scripts/bun-host-peer', metadata] },
        })
      ).toThrow('bun-plugin-tailwind/bun: bun@file:./scripts/bun-host-peer');
    }
    expect(() =>
      assertNoRegistryBunPackages({
        packages: {
          'bun-plugin-tailwind/bun': [
            'bun@file:./scripts/bun-host-peer',
            { bin: { bun: 'bun.exe' } },
          ],
        },
      })
    ).toThrow('invalid lock entry ["bun@file:./scripts/bun-host-peer",{"bin":{"bun":"bun.exe"}}]');
  });

  test('rejects a local Bun copy for another importer', () => {
    expect(() =>
      assertNoRegistryBunPackages({
        packages: { 'another-plugin/bun': ['bun@file:./scripts/bun-host-peer', {}] },
      })
    ).toThrow('another-plugin/bun: bun@file:./scripts/bun-host-peer');
  });
});
