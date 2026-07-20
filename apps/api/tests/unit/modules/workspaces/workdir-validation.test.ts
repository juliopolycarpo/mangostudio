import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  requireValidWorkdir,
  validateWorkdir,
  WorkdirValidationError,
} from '../../../../src/modules/workspaces/application/workdir-validation';

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

  it('throws a typed error when a caller requires a valid directory', async () => {
    const root = await createTempDir();

    await expect(requireValidWorkdir(join(root, 'missing'))).rejects.toBeInstanceOf(
      WorkdirValidationError
    );
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
