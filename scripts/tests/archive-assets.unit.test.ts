import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReleaseAssetPlan } from '../lib/release-assets';
import { archiveReleaseAssets } from '../release/archive-assets';

let tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-release-assets-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }

  tempDirs = [];
});

describe('archiveReleaseAssets', () => {
  test('rejects supported Cursor platforms when the sidecar is missing', async () => {
    const rootDir = makeTempDir();
    const outDir = join(rootDir, 'out');
    const sourceDir = join(outDir, 'linux-x64');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
    writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');

    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64',
    });

    await expect(archiveReleaseAssets(plan)).rejects.toThrow(
      /Invalid linux-x64 Cursor sidecar layout/
    );
  });

  test('rejects supported Cursor platforms when SDK chunks are missing', async () => {
    const rootDir = makeTempDir();
    const outDir = join(rootDir, 'out');
    const sourceDir = join(outDir, 'linux-x64');
    const sidecarDir = join(sourceDir, 'cursor-sidecar');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
    writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'run-agent.mjs'), '#!/usr/bin/env node');
    writeFileSync(join(sidecarDir, 'sidecar-runtime.mjs'), 'export {};');
    mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk'), { recursive: true });
    writeFileSync(
      join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'package.json'),
      JSON.stringify({ name: '@cursor/sdk' })
    );
    mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk-linux-x64'), { recursive: true });
    writeFileSync(
      join(sidecarDir, 'node_modules', '@cursor', 'sdk-linux-x64', 'package.json'),
      JSON.stringify({ name: '@cursor/sdk-linux-x64', bin: { rg: 'bin/rg' } })
    );

    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64',
    });

    await expect(archiveReleaseAssets(plan)).rejects.toThrow(/numbered chunks|chunk directory/);
  });
});
