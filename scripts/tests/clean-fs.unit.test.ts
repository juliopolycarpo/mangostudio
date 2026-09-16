import { describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removePaths, withTempDir } from '../lib/fs';

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

// `process.exit` inside a try terminates before its `finally` runs, so a lane
// that exited on failure from inside a temp directory left it behind — tarball,
// node_modules and all — on every CI retry. The body hands back an exit code
// instead, and the removal is the helper's, not the caller's.
describe('withTempDir', () => {
  test('removes the directory after the body returns', async () => {
    let seen = '';
    const code = await withTempDir('mango-with-temp-', async (dir) => {
      seen = dir;
      await writeFile(join(dir, 'artifact.txt'), 'packed');
      return 0;
    });

    expect(code).toBe(0);
    await expect(access(seen)).rejects.toThrow();
  });

  test('carries the body exit code back instead of exiting inside it', async () => {
    const code = await withTempDir('mango-with-temp-', () => Promise.resolve(7));
    expect(code).toBe(7);
  });

  test('removes the directory when the body throws, and rethrows', async () => {
    let seen = '';
    const failing = withTempDir('mango-with-temp-', async (dir) => {
      seen = dir;
      await writeFile(join(dir, 'artifact.txt'), 'packed');
      throw new Error('pack failed');
    });

    await expect(failing).rejects.toThrow('pack failed');
    await expect(access(seen)).rejects.toThrow();
  });
});
