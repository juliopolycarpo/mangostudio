import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ImportMcpServersResponse,
  MCP_IMPORT_MAX_SOURCE_BYTES,
  type McpImportPreviewResponse,
  McpImportPreviewResponseSchema,
  type McpServerListResponse,
} from '@mangostudio/shared/mcp';
import Value from 'typebox/value';
import { loadConfigForTest } from '../../../src/lib/config';
import { mcpServerRoutes } from '../../../src/modules/mcp-servers/http/mcp-server-routes';
import { closeAllMcpClients } from '../../../src/services/mcp/connection-manager';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

// The in-memory database is shared by every test in this process, so each
// test gets a fresh user id to keep its server list and slug space isolated.
let userSeq = 0;
let testUser: { id: string; name: string; email: string };

let secretDir: string;
let sourceDir: string;
let restoreAuth: (() => void) | null = null;

const SOURCE = {
  mcpServers: {
    github: {
      command: 'bunx',
      args: ['@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'literal-token' },
    },
    remote: {
      url: 'https://mcp.example.com/',
      headers: { Authorization: 'Bearer import-secret-value' },
    },
    legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
  },
};

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  userSeq += 1;
  testUser = {
    id: `mcp-import-user-${userSeq}`,
    name: 'MCP Import User',
    email: `mcp-import-${userSeq}@mangostudio.test`,
  };
  secretDir = mkdtempSync(join(tmpdir(), 'mango-mcp-import-secrets-'));
  sourceDir = mkdtempSync(join(tmpdir(), 'mango-mcp-import-sources-'));
  // Mirror the preload's base test config; overriding only `secretStore` would
  // reset the auth secret and break `getAuth()` inside the routes under test.
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    secretStore: { unsafeFileFallbackDir: secretDir },
  });
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await closeAllMcpClients();
  rmSync(secretDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

function authedApp() {
  restoreAuth?.();
  const { app, restore } = createAuthenticatedApiTestApp(testUser, mcpServerRoutes);
  restoreAuth = restore;
  return app;
}

describe('mcp import routes', () => {
  it('rejects unauthenticated requests', async () => {
    const app = createApiTestApp(mcpServerRoutes);

    const preview = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { json: '{}' })
    );
    const apply = await app.handle(
      jsonRequest('/mcp/servers/import', 'POST', { json: '{}', slugs: ['github'] })
    );

    expect(preview.status).toBe(401);
    expect(apply.status).toBe(401);
  });

  it('previews pasted JSON: creatable, unsupported, and duplicate entries', async () => {
    const app = authedApp();
    await app.handle(
      jsonRequest('/mcp/servers', 'POST', {
        name: 'Existing',
        slug: 'remote',
        transport: 'http',
        url: 'https://existing.example.com/',
      })
    );

    const preview = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { json: JSON.stringify(SOURCE) })
    );
    const payload = (await preview.json()) as McpImportPreviewResponse;

    expect(preview.status).toBe(200);
    expect(Value.Check(McpImportPreviewResponseSchema, payload)).toBe(true);
    expect(payload.entries).toMatchObject([
      { slug: 'github', transport: 'stdio', action: 'create' },
      { slug: 'remote', action: 'skip-duplicate', reason: 'duplicate-slug' },
      { slug: 'legacy', action: 'unsupported', reason: 'unsupported-transport' },
    ]);
    expect(JSON.stringify(payload)).not.toContain('import-secret-value');
  });

  it('requires exactly one of path and json', async () => {
    const app = authedApp();

    const neither = await app.handle(jsonRequest('/mcp/servers/import/preview', 'POST', {}));
    const both = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { path: '/tmp/mcp.json', json: '{}' })
    );

    expect(neither.status).toBe(422);
    expect(both.status).toBe(422);
    expect(await both.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('imports selected entries, stores headers in the secret store, and skips the rest', async () => {
    const app = authedApp();

    const apply = await app.handle(
      jsonRequest('/mcp/servers/import', 'POST', {
        json: JSON.stringify(SOURCE),
        slugs: ['github', 'remote', 'legacy'],
      })
    );
    const payload = (await apply.json()) as ImportMcpServersResponse;

    expect(apply.status).toBe(200);
    expect(payload.results).toMatchObject([
      { slug: 'github', result: 'created' },
      { slug: 'remote', result: 'created' },
      { slug: 'legacy', result: 'unsupported', reason: 'unsupported-transport' },
    ]);

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    const listPayload = (await list.json()) as McpServerListResponse;
    expect(listPayload.servers).toMatchObject([
      {
        slug: 'github',
        transport: 'stdio',
        command: 'bunx',
        env: {},
        secretEnvNames: ['GITHUB_TOKEN'],
      },
      { slug: 'remote', transport: 'http', headerNames: ['Authorization'] },
    ]);
    expect(JSON.stringify(listPayload)).not.toContain('import-secret-value');
  });

  it('only imports slugs that were selected', async () => {
    const app = authedApp();

    const apply = await app.handle(
      jsonRequest('/mcp/servers/import', 'POST', {
        json: JSON.stringify(SOURCE),
        slugs: ['github'],
      })
    );
    const payload = (await apply.json()) as ImportMcpServersResponse;

    expect(payload.results).toMatchObject([{ slug: 'github', result: 'created' }]);

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    expect(((await list.json()) as McpServerListResponse).servers).toHaveLength(1);
  });

  it('re-importing the same source skips duplicates instead of failing', async () => {
    const app = authedApp();
    const body = { json: JSON.stringify(SOURCE), slugs: ['github', 'remote'] };

    await app.handle(jsonRequest('/mcp/servers/import', 'POST', body));
    const again = await app.handle(jsonRequest('/mcp/servers/import', 'POST', body));
    const payload = (await again.json()) as ImportMcpServersResponse;

    expect(again.status).toBe(200);
    expect(payload.results).toMatchObject([
      { slug: 'github', result: 'skip-duplicate', reason: 'duplicate-slug' },
      { slug: 'remote', result: 'skip-duplicate', reason: 'duplicate-slug' },
    ]);

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    expect(((await list.json()) as McpServerListResponse).servers).toHaveLength(2);
  });

  it('reads sources from an absolute .json path', async () => {
    const app = authedApp();
    const sourcePath = join(sourceDir, 'mcp.json');
    writeFileSync(sourcePath, JSON.stringify(SOURCE));

    const preview = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { path: sourcePath })
    );
    const payload = (await preview.json()) as McpImportPreviewResponse;

    expect(preview.status).toBe(200);
    expect(payload.entries).toHaveLength(3);
  });

  it('rejects relative, non-json, missing, and oversized paths', async () => {
    const app = authedApp();
    const oversizedPath = join(sourceDir, 'huge.json');
    writeFileSync(oversizedPath, `{"pad": "${'x'.repeat(MCP_IMPORT_MAX_SOURCE_BYTES)}"}`);
    const tomlPath = join(sourceDir, 'mcp.toml');
    writeFileSync(tomlPath, '');

    const relative = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { path: '../etc/mcp.json' })
    );
    const wrongExt = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { path: tomlPath })
    );
    const missing = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { path: join(sourceDir, 'nope.json') })
    );
    const oversized = await app.handle(
      jsonRequest('/mcp/servers/import/preview', 'POST', { path: oversizedPath })
    );

    expect(relative.status).toBe(422);
    expect(wrongExt.status).toBe(422);
    expect(missing.status).toBe(404);
    expect(oversized.status).toBe(422);
    expect(await oversized.json()).toMatchObject({ code: 'VALIDATION' });
  });
});
