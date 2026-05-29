import { describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removePaths } from '../lib/fs';

// Exercises the helper against a real isolated temp directory (no mocking of the
// filesystem, which would test nothing) and cleans it up so no data leaks.
describe('removePaths', () => {
  test('removes files and directories relative to the base dir', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mango-clean-'));
    await mkdir(join(base, 'dist', 'nested'), { recursive: true });
    await writeFile(join(base, 'dist', 'nested', 'app.js'), 'build');
    await writeFile(join(base, 'leftover.txt'), 'stale');

    await removePaths(['dist', 'leftover.txt'], base);

    await expect(access(join(base, 'dist'))).rejects.toThrow();
    await expect(access(join(base, 'leftover.txt'))).rejects.toThrow();

    await rm(base, { recursive: true, force: true });
  });

  test('ignores paths that do not exist', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mango-clean-'));

    await expect(removePaths(['does-not-exist'], base)).resolves.toBeUndefined();

    await rm(base, { recursive: true, force: true });
  });
});
