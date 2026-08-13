import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultRuleFilesResponseSchema,
  RuleFilePreviewResponseSchema,
} from '@mangostudio/shared/prompt-rules';
import Value from 'typebox/value';
import { settingsRoutes } from '../../../src/routes/settings';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'rule-files-integration-user',
  name: 'Rule Files User',
  email: 'rule-files@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;
let tmpDir: string;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function createTempFile(name: string, content: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'mango-rule-int-'));
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('settings rule-files routes', () => {
  it('blocks unauthenticated requests', async () => {
    const app = createApiTestApp(settingsRoutes);

    const response = await app.handle(new Request('http://localhost/settings/rule-files/defaults'));

    expect(response.status).toBe(401);
  });

  it('returns default rule file descriptors', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/rule-files/defaults'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(Value.Check(DefaultRuleFilesResponseSchema, payload)).toBe(true);

    const data = payload as { files: unknown[] };
    expect(data.files.length).toBe(2);

    const kinds = data.files.map((f) => (f as { kind?: string }).kind).sort();
    expect(kinds).toEqual(['agents', 'claude']);
  });

  it('previews a valid .md file', async () => {
    const filePath = createTempFile('rules.md', '# Rule File\n\nTest content.');
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/rule-files/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(Value.Check(RuleFilePreviewResponseSchema, payload)).toBe(true);
    expect(payload).toMatchObject({
      content: '# Rule File\n\nTest content.',
      truncated: false,
      exists: true,
      readable: true,
    });
  });

  it('rejects non-.md path for preview', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mango-rule-int-'));
    const filePath = join(tmpDir, 'rules.txt');
    writeFileSync(filePath, 'not markdown', 'utf8');

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/rule-files/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects directory path for preview', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mango-rule-int-'));
    const dirPath = join(tmpDir, 'not-a-file.md');
    mkdirSync(dirPath);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/rule-files/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({ code: 'VALIDATION' });
  });

  it('returns 404 for missing files', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mango-rule-int-'));
    const missingPath = join(tmpDir, 'nonexistent.md');

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/rule-files/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: missingPath }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('truncates large files', async () => {
    const MAX_BYTES = 256 * 1024;
    const filePath = createTempFile('large.md', 'x'.repeat(MAX_BYTES + 500));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/rule-files/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ truncated: true });
    const data = payload as { content: string };
    expect(data.content.length).toBeLessThanOrEqual(MAX_BYTES);
  });
});
