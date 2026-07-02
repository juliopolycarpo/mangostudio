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
    mkdirSync(join(sourceDir, 'public'), { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
    writeFileSync(join(sourceDir, 'public', 'index.html'), '<!doctype html>');
    writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');

    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64',
    });

    await expect(archiveReleaseAssets(plan)).rejects.toThrow(
      /Missing linux-x64 Cursor sidecar script/
    );
  });
});
