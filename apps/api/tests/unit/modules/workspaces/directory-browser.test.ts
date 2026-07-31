/**
 * Hub facade smoke tests. Algorithm coverage lives in `@mangostudio/runtime`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectory } from '../../../../src/modules/workspaces/application/directory-browser';
import {
  requireValidWorkdir,
  validateWorkdir,
  WorkdirValidationError,
} from '../../../../src/modules/workspaces/application/workdir-validation';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-workspace-facade-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace facades', () => {
  it('listDirectory still returns DirectoryBrowserError for relative paths', async () => {
    await expect(listDirectory('relative/path')).rejects.toMatchObject({
      name: 'DirectoryBrowserError',
      code: 'VALIDATION',
    });
  });

  it('listDirectory browses through the runtime client', async () => {
    const root = await createTempDir();
    await mkdir(join(root, 'child'));

    const result = await listDirectory(root);
    expect(result.entries.map((entry) => entry.name)).toEqual(['child']);
  });

  it('validateWorkdir and requireValidWorkdir keep hub error types', async () => {
    const root = await createTempDir();

    expect(await validateWorkdir(root)).toMatchObject({ ok: true });
    await expect(requireValidWorkdir(join(root, 'missing'))).rejects.toBeInstanceOf(
      WorkdirValidationError
    );
  });
});
