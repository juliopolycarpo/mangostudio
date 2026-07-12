import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTurboBuildCommand, selectBuildWorkspaces } from '../lib/build';
import { readText } from './support/read-text';

describe('build script', () => {
  test('keeps only build-capable workspaces', () => {
    expect(selectBuildWorkspaces(['frontend', 'shared', 'api'])).toEqual({
      runnableWorkspaces: ['frontend', 'api'],
      skippedWorkspaces: ['shared'],
    });
  });

  test('creates one filtered Turbo invocation for selected workspaces', () => {
    expect(createTurboBuildCommand(['api', 'frontend'])).toEqual([
      'turbo',
      'run',
      'build',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/frontend',
    ]);
  });

  test('exposes explicit root build scripts for turbo and binary packaging', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.build).toBe('bun ./scripts/build.ts');
    expect(manifest.scripts?.['build:binary']).toBe('bun ./scripts/build.ts --binary');
    expect(manifest.scripts?.['build:turbo']).toBe('turbo run build');
  });

  test('declares package-local Turbo outputs for build caching', () => {
    const apiTurbo = readText('apps/api/turbo.json');
    const frontendTurbo = readText('apps/frontend/turbo.json');

    for (const turboConfig of [apiTurbo, frontendTurbo]) {
      expect(turboConfig).toContain('"extends": ["//"]');
      expect(turboConfig).toContain('"outputs": ["dist/**"]');
    }
  });

  test('delegates workspace builds to one filtered Turbo command', () => {
    const buildScript = readText('scripts/build.ts');

    expect(buildScript).toContain('createTurboBuildCommand');
    expect(buildScript).toContain("runCommand('build'");
    expect(buildScript).not.toContain('runParallel(');
  });

  test('keeps root formatting checks aware of Turbo configuration files', () => {
    const rootConfig = readText('scripts/lib/config.ts');

    expect(rootConfig).toContain("'turbo.jsonc'");
    expect(rootConfig).toContain("'apps/api/turbo.json'");
    expect(rootConfig).toContain("'apps/frontend/turbo.json'");
  });

  test('uses the binary alias for standalone smoke builds', () => {
    expect(readText('scripts/test-build.ts')).toContain("'build:binary'");
  });

  test('loads the standalone smoke script before build output exists', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'scripts/test-build.ts'],
      env: {
        ...process.env,
        DISTRIBUTION_CHANNEL: 'test',
        DISTRIBUTION_MANIFEST_PATH: join(
          tmpdir(),
          'mangostudio-missing-distribution-manifest.json'
        ),
        PLATFORM: 'linux-x64-musl',
        SKIP_BUILD: '1',
        SOURCE_SHA: 'abcdef0',
      },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(output).toContain('platform: linux-x64-musl');
    expect(output).toContain('Missing distribution manifest');
    expect(output).not.toContain('Building binary');
    expect(output).not.toContain('ReferenceError');
  });
});
