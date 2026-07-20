import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectory } from '../../../../src/modules/workspaces/application/directory-browser';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-workspace-browser-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('listDirectory', () => {
  it('returns directories only, sorted case-insensitively, with hidden metadata', async () => {
    const root = await createTempDir();
    await Promise.all([
      mkdir(join(root, 'zeta')),
      mkdir(join(root, 'Alpha')),
      mkdir(join(root, 'beta')),
      mkdir(join(root, '.hidden')),
      writeFile(join(root, 'notes.txt'), 'not a directory'),
    ]);

    const result = await listDirectory(root);

    expect(result.entries.map((entry) => entry.name)).toEqual(['.hidden', 'Alpha', 'beta', 'zeta']);
    expect(result.entries.find((entry) => entry.name === '.hidden')?.hidden).toBe(true);
    expect(result.entries.find((entry) => entry.name === 'Alpha')?.hidden).toBe(false);
    expect(result.entries.every((entry) => entry.path.startsWith(root))).toBe(true);
  });

  it('follows directory symlinks without including file symlinks', async () => {
    const root = await createTempDir();
    const target = join(root, 'target');
    const file = join(root, 'file.txt');
    await mkdir(target);
    await writeFile(file, 'file');
    await symlink(target, join(root, 'directory-link'));
    await symlink(file, join(root, 'file-link'));

    const result = await listDirectory(root);

    expect(result.entries.map((entry) => entry.name)).toEqual(['directory-link', 'target']);
  });

  it('rejects relative browse paths', async () => {
    await expect(listDirectory('relative/path')).rejects.toMatchObject({
      name: 'DirectoryBrowserError',
      code: 'VALIDATION',
    });
  });

  it('maps missing paths without exposing raw filesystem messages', async () => {
    const root = await createTempDir();

    await expect(listDirectory(join(root, 'missing'))).rejects.toEqual(
      expect.objectContaining({
        name: 'DirectoryBrowserError',
        reason: 'not-found',
      })
    );
  });

  it.skipIf(process.platform === 'win32')(
    'maps unreadable directories to permission-denied',
    async () => {
      const root = await createTempDir();
      const unreadable = join(root, 'unreadable');
      await mkdir(unreadable);
      await chmod(unreadable, 0o000);

      try {
        await expect(listDirectory(unreadable)).rejects.toMatchObject({
          name: 'DirectoryBrowserError',
          reason: 'permission-denied',
        });
      } finally {
        await chmod(unreadable, 0o700);
      }
    }
  );
});
