import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type McpServer,
  type McpServerListResponse,
  McpServerSchema,
  type TestMcpServerResponse,
  TestMcpServerResponseSchema,
} from '@mangostudio/shared/mcp';
import { Value } from '@sinclair/typebox/value';
import { loadConfigForTest } from '../../../src/lib/config';
import { mcpServerRoutes } from '../../../src/modules/mcp-servers/http/mcp-server-routes';
import { closeAllMcpClients } from '../../../src/services/mcp/connection-manager';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

// The in-memory database is shared by every test in this process, so each
// test gets fresh user ids to keep its server list and slug space isolated.
let userSeq = 0;
let testUser: { id: string; name: string; email: string };
let otherUser: { id: string; name: string; email: string };

const FIXTURE_PATH = join(import.meta.dir, '../../support/fixtures/mcp/echo-stdio-server.ts');

let secretDir: string;
let restoreAuth: (() => void) | null = null;

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function stdioBody(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    name: `Server ${slug}`,
    slug,
    transport: 'stdio',
    command: 'bun',
    args: ['server.ts'],
    env: { MCP_FLAG: 'on' },
    ...overrides,
  };
}

beforeEach(() => {
  userSeq += 1;
  testUser = {
    id: `mcp-routes-user-${userSeq}`,
    name: 'MCP Routes User',
    email: `mcp-routes-${userSeq}@mangostudio.test`,
  };
  otherUser = {
    id: `mcp-routes-other-user-${userSeq}`,
    name: 'Other MCP Routes User',
    email: `other-mcp-routes-${userSeq}@mangostudio.test`,
  };
  secretDir = mkdtempSync(join(tmpdir(), 'mango-mcp-routes-secrets-'));
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
});

function authedApp(user?: { id: string; name: string; email: string }) {
  // Restore the previous session patch before installing the next one —
  // the patches nest, and restoring afterwards would undo the new one.
  restoreAuth?.();
  const { app, restore } = createAuthenticatedApiTestApp(user ?? testUser, mcpServerRoutes);
  restoreAuth = restore;
  return app;
}

describe('mcp server routes', () => {
  it('rejects unauthenticated requests', async () => {
    const app = createApiTestApp(mcpServerRoutes);

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    const create = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));

    expect(list.status).toBe(401);
    expect(create.status).toBe(401);
  });

  it('creates a stdio server and lists it with last-known status', async () => {
    const app = authedApp();

    const created = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));
    const payload = (await created.json()) as McpServer;

    expect(created.status).toBe(201);
    expect(Value.Check(McpServerSchema, payload)).toBe(true);
    expect(payload).toMatchObject({
      name: 'Server github',
      slug: 'github',
      transport: 'stdio',
      command: 'bun',
      args: ['server.ts'],
      env: { MCP_FLAG: 'on' },
      url: null,
      headerNames: [],
      enabled: true,
      timeoutMs: null,
      status: 'disconnected',
    });

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    const listPayload = (await list.json()) as McpServerListResponse;
    expect(listPayload.servers).toHaveLength(1);
    expect(listPayload.servers[0]?.id).toBe(payload.id);
  });

  it('rejects malformed slugs and invalid transport configs', async () => {
    const app = authedApp();

    const badSlug = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('Bad Slug!')));
    expect(badSlug.status).toBe(422);

    const badUrl = await app.handle(
      jsonRequest('/mcp/servers', 'POST', {
        name: 'Bad URL',
        slug: 'bad-url',
        transport: 'http',
        url: 'ftp://example.com',
      })
    );
    expect(badUrl.status).toBe(422);
    expect(await badUrl.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('returns 409 for a duplicate slug, scoped per user', async () => {
    const app = authedApp();
    await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));

    const duplicate = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'CONFLICT' });

    const otherApp = authedApp(otherUser);
    const sameSlugOtherUser = await otherApp.handle(
      jsonRequest('/mcp/servers', 'POST', stdioBody('github'))
    );
    expect(sameSlugOtherUser.status).toBe(201);
  });

  it('stores http auth headers write-only: names come back, values never do', async () => {
    const app = authedApp();

    const created = await app.handle(
      jsonRequest('/mcp/servers', 'POST', {
        name: 'Remote',
        slug: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com/',
        headers: { Authorization: 'Bearer super-secret-value', 'X-Api-Key': 'also-secret' },
      })
    );
    const payload = (await created.json()) as McpServer;

    expect(created.status).toBe(201);
    expect(payload.headerNames).toEqual(['Authorization', 'X-Api-Key']);
    expect(JSON.stringify(payload)).not.toContain('super-secret-value');
    expect(JSON.stringify(payload)).not.toContain('also-secret');

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    expect(JSON.stringify(await list.json())).not.toContain('super-secret-value');

    const cleared = await app.handle(
      jsonRequest(`/mcp/servers/${payload.id}`, 'PUT', { headers: {} })
    );
    expect(((await cleared.json()) as McpServer).headerNames).toEqual([]);
  });

  it('updates a server and enforces merged transport invariants', async () => {
    const app = authedApp();
    const created = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));
    const { id } = (await created.json()) as McpServer;

    const renamed = await app.handle(
      jsonRequest(`/mcp/servers/${id}`, 'PUT', { name: 'Renamed', enabled: false, args: [] })
    );
    const renamedPayload = (await renamed.json()) as McpServer;
    expect(renamed.status).toBe(200);
    expect(renamedPayload).toMatchObject({ name: 'Renamed', enabled: false, args: [] });

    const badSwitch = await app.handle(
      jsonRequest(`/mcp/servers/${id}`, 'PUT', { transport: 'http' })
    );
    expect(badSwitch.status).toBe(422);
    expect(await badSwitch.json()).toMatchObject({ code: 'VALIDATION' });

    await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('other')));
    const slugConflict = await app.handle(
      jsonRequest(`/mcp/servers/${id}`, 'PUT', { slug: 'other' })
    );
    expect(slugConflict.status).toBe(409);
  });

  it('hides other users servers from read, update, and delete', async () => {
    const app = authedApp();
    const created = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));
    const { id } = (await created.json()) as McpServer;

    const otherApp = authedApp(otherUser);
    const update = await otherApp.handle(
      jsonRequest(`/mcp/servers/${id}`, 'PUT', { name: 'Hijacked' })
    );
    const remove = await otherApp.handle(jsonRequest(`/mcp/servers/${id}`, 'DELETE'));
    const probe = await otherApp.handle(jsonRequest(`/mcp/servers/${id}/test`, 'POST'));
    const tools = await otherApp.handle(jsonRequest(`/mcp/servers/${id}/tools`, 'GET'));
    const otherList = await otherApp.handle(jsonRequest('/mcp/servers', 'GET'));

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(probe.status).toBe(404);
    expect(tools.status).toBe(404);
    expect(((await otherList.json()) as McpServerListResponse).servers).toHaveLength(0);
  });

  it('deletes a server', async () => {
    const app = authedApp();
    const created = await app.handle(jsonRequest('/mcp/servers', 'POST', stdioBody('github')));
    const { id } = (await created.json()) as McpServer;

    const removed = await app.handle(jsonRequest(`/mcp/servers/${id}`, 'DELETE'));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    expect(((await list.json()) as McpServerListResponse).servers).toHaveLength(0);

    const missing = await app.handle(jsonRequest(`/mcp/servers/${id}`, 'DELETE'));
    expect(missing.status).toBe(404);
  });

  it('probes a reachable stdio server: connect, tools, connected status', async () => {
    const app = authedApp();
    const created = await app.handle(
      jsonRequest(
        '/mcp/servers',
        'POST',
        stdioBody('echo-fixture', { command: process.execPath, args: [FIXTURE_PATH], env: {} })
      )
    );
    const { id } = (await created.json()) as McpServer;

    const probe = await app.handle(jsonRequest(`/mcp/servers/${id}/test`, 'POST'));
    const probePayload = (await probe.json()) as TestMcpServerResponse;

    expect(probe.status).toBe(200);
    expect(Value.Check(TestMcpServerResponseSchema, probePayload)).toBe(true);
    expect(probePayload.ok).toBe(true);
    expect(probePayload.status).toBe('connected');
    expect(probePayload.tools?.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);

    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    expect(((await list.json()) as McpServerListResponse).servers[0]?.status).toBe('connected');

    const tools = await app.handle(jsonRequest(`/mcp/servers/${id}/tools`, 'GET'));
    expect(tools.status).toBe(200);
    expect(await tools.json()).toMatchObject({
      tools: [{ name: 'echo' }, { name: 'env-keys' }, { name: 'crash' }],
    });
  });

  it('reports unreachable servers through the probe body and 502 on tools', async () => {
    const app = authedApp();
    const created = await app.handle(
      jsonRequest('/mcp/servers', 'POST', {
        name: 'Unreachable',
        slug: 'unreachable',
        transport: 'http',
        url: 'http://127.0.0.1:9/',
      })
    );
    const { id } = (await created.json()) as McpServer;

    const probe = await app.handle(jsonRequest(`/mcp/servers/${id}/test`, 'POST'));
    const probePayload = (await probe.json()) as TestMcpServerResponse;

    expect(probe.status).toBe(200);
    expect(Value.Check(TestMcpServerResponseSchema, probePayload)).toBe(true);
    expect(probePayload.ok).toBe(false);
    expect(probePayload.status).toBe('error');
    expect(probePayload.error).toBeString();

    const tools = await app.handle(jsonRequest(`/mcp/servers/${id}/tools`, 'GET'));
    expect(tools.status).toBe(502);
    expect(await tools.json()).toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('POST /mcp/elicitations/:id/respond', () => {
  it('resolves a pending elicitation for the owner and 404s otherwise', async () => {
    const { bindElicitationSink, createPendingElicitation, resetElicitationRegistryForTest } =
      await import('../../../src/services/mcp/elicitation-registry');
    resetElicitationRegistryForTest();

    const app = authedApp();
    const missing = await app.handle(
      jsonRequest('/mcp/elicitations/missing/respond', 'POST', { action: 'cancel' })
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND' });

    let elicitationId = '';
    bindElicitationSink(testUser.id, 'server-1', (part) => {
      elicitationId = part.elicitationId;
    });
    const wait = createPendingElicitation({
      userId: testUser.id,
      serverId: 'server-1',
      serverSlug: 'demo',
      toolCallId: 'call-1',
      message: 'Need a name',
      fields: [{ name: 'name', required: true, kind: 'string' }],
    });

    const accepted = await app.handle(
      jsonRequest(`/mcp/elicitations/${elicitationId}/respond`, 'POST', {
        action: 'accept',
        content: { name: 'Ada' },
      })
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, status: 'accepted' });
    await expect(wait).resolves.toEqual({ action: 'accept', content: { name: 'Ada' } });

    const again = await app.handle(
      jsonRequest(`/mcp/elicitations/${elicitationId}/respond`, 'POST', { action: 'cancel' })
    );
    expect(again.status).toBe(404);
  });
});
