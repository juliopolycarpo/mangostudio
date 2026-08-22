import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';
import {
  publishDist,
  removeTempPaths,
  resolveApiUrlOverride,
  trackTempPath,
  writeBuildState,
} from '../../build';

describe('resolveApiUrlOverride', () => {
  test('uses MANGO_API_URL ahead of the deprecated alias', () => {
    const warnings: string[] = [];
    expect(
      resolveApiUrlOverride(
        {
          MANGO_API_URL: 'https://current.example.test',
          VITE_API_URL: 'https://deprecated.example.test',
        },
        (message) => warnings.push(message)
      )
    ).toBe('https://current.example.test');
    expect(warnings).toEqual([]);
  });

  test('supports the deprecated alias and warns when it supplies the value', () => {
    const warnings: string[] = [];
    expect(
      resolveApiUrlOverride({ VITE_API_URL: 'https://deprecated.example.test' }, (message) =>
        warnings.push(message)
      )
    ).toBe('https://deprecated.example.test');
    expect(warnings).toHaveLength(1);
  });

  test('uses an empty string when neither variable is set', () => {
    const warnings: string[] = [];
    expect(resolveApiUrlOverride({}, (message) => warnings.push(message))).toBe('');
    expect(warnings).toEqual([]);
  });
});

describe('publishDist', () => {
  test('replaces the previous directory and removes files absent from the new build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');
      await writeFile(join(dist, 'old-asset.js'), 'old');

      await publishDist(staged, dist);

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('new');
      expect(existsSync(join(dist, 'old-asset.js'))).toBe(false);
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores the previous directory when publishing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const missingStaged = join(root, 'missing-staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(dist);
      await writeFile(join(dist, 'index.html'), 'old');

      await expect(publishDist(missingStaged, dist)).rejects.toThrow();

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('old');
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores the previous directory when finalizing the publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');

      await expect(
        publishDist(staged, dist, () => Promise.reject(new Error('sidecar failed')))
      ).rejects.toThrow('sidecar failed');

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('old');
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The stamp the API's dev server reads back. Its shape is a contract across two
 * workspaces that cannot import each other's code, so it is pinned from both
 * ends: `apps/api/tests/unit/server/dev-frontend.test.ts` asserts the reader
 * accepts exactly these two fields, and this asserts the writer emits them.
 */
describe('writeBuildState', () => {
  test('writes both fields the freshness check compares', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-state-'));
    try {
      await writeBuildState(root, { apiUrl: 'https://api.example.test', mode: 'production' });
      expect(JSON.parse(await readFile(join(root, BUILD_STATE_FILE), 'utf8'))).toEqual({
        apiUrl: 'https://api.example.test',
        mode: 'production',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Interrupt cleanup. `publishDist` moves the live bundle aside before renaming
 * the staged one into place, and Ctrl-C is how the dev server that spawns a
 * build on every boot is normally stopped. Killed in that window the process
 * used to leave `dist/` absent and a full bundle copy under a `.dist-backup-`
 * name nothing ever reaped.
 */
describe('removeTempPaths', () => {
  test('removes tracked directories and files, and forgets them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-temp-'));
    try {
      const directory = trackTempPath(join(root, '.dist-backup-abc'));
      const file = trackTempPath(join(root, '.dist-metafile-staging-abc'));
      await mkdir(directory);
      await writeFile(join(directory, 'index.html'), 'old');
      await writeFile(file, '{}');

      removeTempPaths();

      expect(existsSync(directory)).toBe(false);
      expect(existsSync(file)).toBe(false);

      // Forgotten, not just deleted: a path that stayed tracked would be removed
      // again by a later interrupt, after the name had been reused.
      await mkdir(directory);
      removeTempPaths();
      expect(existsSync(directory)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leaves a published bundle alone after publishDist succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-temp-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');

      await publishDist(staged, dist);
      removeTempPaths();

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('new');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
