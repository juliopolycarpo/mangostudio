import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoRegistryBunPackages, type BunDependencyLock } from '../lib/bun-peer-policy';
import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

describe('Bun peer lockfile policy', () => {
  test('the real lockfile contains no registry Bun runtime', () => {
    const lock = Bun.JSON5.parse(readText('bun.lock')) as BunDependencyLock;
    expect(() => assertNoRegistryBunPackages(lock)).not.toThrow();
  });

  test('pins the only allowed override and its metadata-only package contents', () => {
    const root = JSON.parse(readText('package.json'));
    const marker = JSON.parse(readText('scripts/bun-host-peer/package.json'));
    const lock = Bun.JSON5.parse(readText('bun.lock')) as BunDependencyLock;
    const config = Bun.TOML.parse(readText('bunfig.toml')) as { install?: { peer?: boolean } };

    expect(root.overrides.bun).toBe('file:./scripts/bun-host-peer');
    expect(lock.overrides?.bun).toBe(root.overrides.bun);
    expect(lock.packages['bun-plugin-tailwind/bun']).toEqual([
      'bun@file:./scripts/bun-host-peer',
      {},
    ]);
    expect(marker).toEqual({
      name: '@mangostudio/bun-host-peer',
      version: readText('.bun-version').trim(),
      private: true,
      description:
        'Metadata for the externally installed Bun toolchain, satisfying the Tailwind plugin peer without downloading a registry runtime.',
      exports: {},
    });
    expect(root.packageManager).toBe(`bun@${marker.version}`);
    expect(config.install?.peer).not.toBe(false);
    expect(readdirSync(join(ROOT_DIR, 'scripts/bun-host-peer')).sort()).toEqual([
      'README.md',
      'package.json',
    ]);
  });

  test('runtime imports still resolve to the host Bun builtin', async () => {
    const hostBun = await import('bun');
    expect(hostBun.version).toBe(Bun.version);
    expect(hostBun.build).toBe(Bun.build);
  });

  test('accepts a plugin using host Bun and the exact metadata-only local peer', () => {
    expect(() =>
      assertNoRegistryBunPackages({
        packages: {
          'bun-plugin-tailwind': [
            'bun-plugin-tailwind@0.1.2',
            '',
            { peerDependencies: { bun: '>=1.0.0' } },
          ],
          'bun-plugin-tailwind/bun': ['bun@file:./scripts/bun-host-peer', {}],
          '@types/bun': ['@types/bun@1.4.2', '', {}],
        },
      })
    ).not.toThrow();
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
      'expected only bun-plugin-tailwind/bun: bun@file:./scripts/bun-host-peer with empty metadata'
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
