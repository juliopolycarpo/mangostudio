import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ListDirectoryResponse,
  ListDirectoryResponseSchema,
  ValidatePathResponseSchema,
} from '@mangostudio/shared/workspaces';
import Value from 'typebox/value';
import { workspaceRoutes } from '../../../src/modules/workspaces/http/workspace-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'workspace-routes-user',
  name: 'Workspace Routes User',
  email: 'workspace-routes@mangostudio.test',
};

const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-workspace-routes-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace routes', () => {
  it('browses server-side directories and returns the shared contract', async () => {
    const root = await createTempDir();
    await Promise.all([mkdir(join(root, 'project')), writeFile(join(root, 'notes.txt'), 'file')]);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, workspaceRoutes);
    restoreAuth = restore;

    const url = new URL('http://localhost/workspace/fs');
    url.searchParams.set('path', root);
    const response = await app.handle(new Request(url.toString()));
    const payload = (await response.json()) as ListDirectoryResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(ListDirectoryResponseSchema, payload)).toBe(true);
    expect(payload.entries.map((entry: { name: string }) => entry.name)).toEqual(['project']);
  });

  it('validates directories and regular files through the shared contract', async () => {
    const root = await createTempDir();
    const file = join(root, 'notes.txt');
    await writeFile(file, 'file');
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, workspaceRoutes);
    restoreAuth = restore;

    const valid = await app.handle(
      new Request('http://localhost/workspace/fs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root }),
      })
    );
    const invalid = await app.handle(
      new Request('http://localhost/workspace/fs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
      })
    );
    const validPayload = await valid.json();
    const invalidPayload = await invalid.json();

    expect(valid.status).toBe(200);
    expect(Value.Check(ValidatePathResponseSchema, validPayload)).toBe(true);
    expect(validPayload).toEqual({ ok: true, resolvedPath: root });
    expect(invalid.status).toBe(200);
    expect(Value.Check(ValidatePathResponseSchema, invalidPayload)).toBe(true);
    expect(invalidPayload).toEqual({ ok: false, reason: 'not-a-directory' });
  });

  it('rejects relative browse paths without exposing filesystem details', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, workspaceRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/workspace/fs?path=relative%2Fpath')
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: 'Directory browsing requires an absolute path.',
      code: 'VALIDATION',
    });
  });

  it('requires authentication for browsing and validation', async () => {
    const app = createApiTestApp(workspaceRoutes);
    const browse = await app.handle(new Request('http://localhost/workspace/fs'));
    const validate = await app.handle(
      new Request('http://localhost/workspace/fs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/' }),
      })
    );

    expect(browse.status).toBe(401);
    expect(validate.status).toBe(401);
  });
});
