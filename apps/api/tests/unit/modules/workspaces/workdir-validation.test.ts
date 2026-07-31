/**
 * Hub facade smoke for workdir validation. Runtime owns the filesystem checks.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  requireValidWorkdir,
  validateWorkdir,
  WorkdirValidationError,
} from '../../../../src/modules/workspaces/application/workdir-validation';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-workdir-facade-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('validateWorkdir facade', () => {
  it('returns the resolved path for an existing directory', async () => {
    const root = await createTempDir();

    expect(await validateWorkdir(root)).toEqual({ ok: true, resolvedPath: resolve(root) });
  });

  it('throws a typed error when a caller requires a valid directory', async () => {
    const root = await createTempDir();
    await writeFile(join(root, 'file.txt'), 'file');

    await expect(requireValidWorkdir(join(root, 'missing'))).rejects.toBeInstanceOf(
      WorkdirValidationError
    );
  });
});
