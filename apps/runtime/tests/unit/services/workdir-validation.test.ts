import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateWorkdir } from '../../../src/services/workspace';
import { WorkspacePathError } from '../../../src/services/workspace-path';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-workdir-validation-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('validateWorkdir', () => {
  it('returns the resolved path for an existing directory', async () => {
    const root = await createTempDir();

    expect(await validateWorkdir(root)).toEqual({ ok: true, resolvedPath: resolve(root) });
  });

  it('distinguishes missing paths from regular files', async () => {
    const root = await createTempDir();
    const file = join(root, 'file.txt');
    await writeFile(file, 'file');

    expect(await validateWorkdir(join(root, 'missing'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await validateWorkdir(file)).toEqual({
      ok: false,
      reason: 'not-a-directory',
    });
  });

  it('rejects empty paths with WorkspacePathError', async () => {
    await expect(validateWorkdir('   ')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it.skipIf(process.platform === 'win32')(
    'maps inaccessible directories to permission-denied',
    async () => {
      const root = await createTempDir();
      const inaccessible = join(root, 'inaccessible');
      await mkdir(inaccessible);
      await chmod(inaccessible, 0o000);

      try {
        expect(await validateWorkdir(inaccessible)).toEqual({
          ok: false,
          reason: 'permission-denied',
        });
      } finally {
        await chmod(inaccessible, 0o700);
      }
    }
  );
});
