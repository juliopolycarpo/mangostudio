import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browseWorkspace,
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  WorkspaceBrowserError,
} from '../../../src/services/workspace';

const tempDirs: string[] = [];

/** Windows ignores POSIX mode bits and root bypasses them, so 0o000 stays readable. */
const cannotTestModeBits = process.platform === 'win32' || process.getuid?.() === 0;

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-workspace-browser-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('browseWorkspace', () => {
  it('returns directories only, sorted case-insensitively, with hidden metadata', async () => {
    const root = await createTempDir();
    await Promise.all([
      mkdir(join(root, 'zeta')),
      mkdir(join(root, 'Alpha')),
      mkdir(join(root, 'beta')),
      mkdir(join(root, '.hidden')),
      writeFile(join(root, 'notes.txt'), 'not a directory'),
    ]);

    const result = await browseWorkspace({ path: root });

    expect(result.entries.map((entry) => entry.name)).toEqual(['.hidden', 'Alpha', 'beta', 'zeta']);
    expect(result.entries.find((entry) => entry.name === '.hidden')?.hidden).toBe(true);
    expect(result.entries.find((entry) => entry.name === 'Alpha')?.hidden).toBe(false);
    expect(result.entries.every((entry) => entry.path.startsWith(root))).toBe(true);
    expect(result.truncated).toBeUndefined();
  });

  // Directory symlinks need elevation or developer mode on Windows.
  it.skipIf(process.platform === 'win32')(
    'follows directory symlinks without including file symlinks',
    async () => {
      const root = await createTempDir();
      const target = join(root, 'target');
      const file = join(root, 'file.txt');
      await mkdir(target);
      await writeFile(file, 'file');
      await symlink(target, join(root, 'directory-link'));
      await symlink(file, join(root, 'file-link'));

      const result = await browseWorkspace({ path: root });

      expect(result.entries.map((entry) => entry.name)).toEqual(['directory-link', 'target']);
    }
  );

  it('rejects relative browse paths', async () => {
    await expect(browseWorkspace({ path: 'relative/path' })).rejects.toMatchObject({
      name: 'WorkspaceBrowserError',
      code: 'VALIDATION',
      kind: 'workspace_browser',
    });
  });

  it('maps missing paths without exposing raw filesystem messages', async () => {
    const root = await createTempDir();

    await expect(browseWorkspace({ path: join(root, 'missing') })).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkspaceBrowserError',
        reason: 'not-found',
      })
    );
  });

  it('caps oversized listings and sets truncated', async () => {
    const root = await createTempDir();
    const total = MAX_WORKSPACE_DIRECTORY_ENTRIES + 3;
    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        mkdir(join(root, `dir-${String(index).padStart(5, '0')}`))
      )
    );

    const result = await browseWorkspace({ path: root });

    expect(result.entries).toHaveLength(MAX_WORKSPACE_DIRECTORY_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it.skipIf(cannotTestModeBits)('maps unreadable directories to permission-denied', async () => {
    const root = await createTempDir();
    const unreadable = join(root, 'unreadable');
    await mkdir(unreadable);
    await chmod(unreadable, 0o000);

    try {
      await expect(browseWorkspace({ path: unreadable })).rejects.toMatchObject({
        name: 'WorkspaceBrowserError',
        reason: 'permission-denied',
      });
      expect(WorkspaceBrowserError).toBeDefined();
    } finally {
      await chmod(unreadable, 0o700);
    }
  });
});
