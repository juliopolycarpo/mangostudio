import { afterEach, describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveContainedWorkspacePath,
  WorkspaceContainmentError,
} from '../../../src/services/workspace';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  // realpath up front: tmpdir() is a symlink on macOS and containment compares
  // against the canonical root.
  const path = realpathSync(await mkdtemp(join(tmpdir(), 'mango-contained-')));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('resolveContainedWorkspacePath', () => {
  it('returns the root-relative path for a file inside the root', async () => {
    const root = await createTempDir();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export {};');

    expect(await resolveContainedWorkspacePath({ root, path: 'src/index.ts' })).toEqual({
      relativePath: join('src', 'index.ts'),
    });
  });

  it('normalizes backslash separators so foreign-style paths resolve natively', async () => {
    const root = await createTempDir();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export {};');

    expect(await resolveContainedWorkspacePath({ root, path: 'src\\index.ts' })).toEqual({
      relativePath: join('src', 'index.ts'),
    });
  });

  it('reports a missing path as null rather than an escape', async () => {
    const root = await createTempDir();

    expect(await resolveContainedWorkspacePath({ root, path: 'absent.txt' })).toEqual({
      relativePath: null,
    });
  });

  // Directory symlinks need elevation or developer mode on Windows.
  it.skipIf(process.platform === 'win32')(
    'rejects a symlink that resolves outside the root',
    async () => {
      const root = await createTempDir();
      const outside = await createTempDir();
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(root, 'escape'));

      await expect(
        resolveContainedWorkspacePath({ root, path: 'escape/secret.txt' })
      ).rejects.toBeInstanceOf(WorkspaceContainmentError);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'accepts a symlink that stays inside the root',
    async () => {
      const root = await createTempDir();
      await mkdir(join(root, 'real'));
      await writeFile(join(root, 'real', 'file.txt'), 'inside');
      await symlink(join(root, 'real'), join(root, 'link'));

      expect(await resolveContainedWorkspacePath({ root, path: 'link/file.txt' })).toEqual({
        relativePath: join('real', 'file.txt'),
      });
    }
  );

  it('rejects the root itself, which is not a path within the root', async () => {
    const root = await createTempDir();

    await expect(resolveContainedWorkspacePath({ root, path: '.' })).rejects.toBeInstanceOf(
      WorkspaceContainmentError
    );
  });
});
