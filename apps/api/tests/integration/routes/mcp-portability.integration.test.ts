import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExportMcpServersResponse,
  McpPortabilityApplyResponse,
  McpPortabilityPreviewResponse,
  McpServer,
  McpServerListResponse,
} from '@mangostudio/shared/mcp';
import {
  ExportMcpServersResponseSchema,
  McpPortabilityApplyResponseSchema,
  McpPortabilityPreviewResponseSchema,
} from '@mangostudio/shared/mcp';
import { Value } from '@sinclair/typebox/value';
import { loadConfigForTest } from '../../../src/lib/config';
import { mcpServerRoutes } from '../../../src/modules/mcp-servers/http/mcp-server-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { closeAllMcpClients } from '../../../src/services/mcp/connection-manager';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

let userSeq = 0;
let owner: { id: string; name: string; email: string };
let destination: { id: string; name: string; email: string };
let secretDir: string;
let extraSecretDirs: string[];
let restoreAuth: (() => void) | null = null;

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  userSeq += 1;
  owner = {
    id: `mcp-portability-owner-${userSeq}`,
    name: 'Portability Owner',
    email: `mcp-portability-owner-${userSeq}@mangostudio.test`,
  };
  destination = {
    id: `mcp-portability-destination-${userSeq}`,
    name: 'Portability Destination',
    email: `mcp-portability-destination-${userSeq}@mangostudio.test`,
  };
  secretDir = mkdtempSync(join(tmpdir(), 'mango-mcp-portability-secrets-'));
  extraSecretDirs = [];
  useSecretStore(secretDir);
});

function useSecretStore(directory: string): void {
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    secretStore: { unsafeFileFallbackDir: directory },
  });
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await closeAllMcpClients();
  rmSync(secretDir, { recursive: true, force: true });
  for (const directory of extraSecretDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function authedApp(user = owner) {
  restoreAuth?.();
  const { app, restore } = createAuthenticatedApiTestApp(user, mcpServerRoutes);
  restoreAuth = restore;
  return app;
}

async function addServer(app: ReturnType<typeof authedApp>, body: unknown): Promise<McpServer> {
  const response = await app.handle(jsonRequest('/mcp/servers', 'POST', body));
  expect(response.status).toBe(201);
  return (await response.json()) as McpServer;
}

async function preview(app: ReturnType<typeof authedApp>, json: string) {
  const response = await app.handle(
    jsonRequest('/mcp/servers/portability/import/preview', 'POST', { json })
  );
  const payload = (await response.json()) as McpPortabilityPreviewResponse;
  expect(response.status).toBe(200);
  expect(Value.Check(McpPortabilityPreviewResponseSchema, payload)).toBe(true);
  return payload;
}

describe('mcp portability routes', () => {
  it('requires authentication for export, preview, and apply', async () => {
    const app = createApiTestApp(mcpServerRoutes);
    const exportResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', { all: true })
    );
    const previewResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/import/preview', 'POST', { json: '{}' })
    );
    const applyResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: '{}',
        previewToken: '0'.repeat(64),
        decisions: [],
      })
    );

    expect(exportResponse.status).toBe(401);
    expect(previewResponse.status).toBe(401);
    expect(applyResponse.status).toBe(401);
  });

  it('enforces export ownership and keeps validation errors free of write-only values', async () => {
    const ownerApp = authedApp();
    const owned = await addServer(ownerApp, {
      name: 'Owned',
      slug: 'owned',
      transport: 'stdio',
      command: 'bun',
    });
    const destinationApp = authedApp(destination);
    const foreignExport = await destinationApp.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', { serverIds: [owned.id] })
    );
    expect(foreignExport.status).toBe(404);

    restoreAuth?.();
    const { app: productionLikeApp, restore } = createAuthenticatedApiTestApp(
      destination,
      errorHandler,
      mcpServerRoutes
    );
    restoreAuth = restore;
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    try {
      const invalidApply = await productionLikeApp.handle(
        jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
          json: '{}',
          previewToken: 'invalid-token',
          decisions: [
            {
              key: 'server',
              decision: 'add',
              headers: { Authorization: 'schema-validation-secret-sentinel' },
            },
          ],
        })
      );
      const errorText = await invalidApply.text();
      expect(invalidApply.status).toBe(422);
      expect(errorText).not.toContain('schema-validation-secret-sentinel');
      expect(JSON.stringify(loggedErrors)).not.toContain('schema-validation-secret-sentinel');
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('round-trips stable selected configuration without exporting secret values', async () => {
    const ownerApp = authedApp();
    await addServer(ownerApp, {
      name: 'Zulu stdio',
      slug: 'zulu',
      transport: 'stdio',
      command: 'bunx',
      args: ['server-z'],
      env: { LOG_LEVEL: 'debug' },
      secretEnv: { API_TOKEN: 'owner-stdio-sentinel' },
    });
    await addServer(ownerApp, {
      name: 'Alpha HTTP',
      slug: 'alpha',
      transport: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer owner-http-sentinel' },
    });

    const exportResponse = await ownerApp.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', { all: true })
    );
    const exported = (await exportResponse.json()) as ExportMcpServersResponse;
    expect(exportResponse.status).toBe(200);
    expect(Value.Check(ExportMcpServersResponseSchema, exported)).toBe(true);
    expect(exported.serverCount).toBe(2);
    expect(exported.content.indexOf('"alpha"')).toBeLessThan(exported.content.indexOf('"zulu"'));
    expect(exported.content).not.toContain('owner-stdio-sentinel');
    expect(exported.content).not.toContain('owner-http-sentinel');
    expect(exported.content).toContain('API_TOKEN');
    expect(exported.content).toContain('Authorization');

    const destinationSecretDir = mkdtempSync(
      join(tmpdir(), 'mango-mcp-portability-destination-secrets-')
    );
    extraSecretDirs.push(destinationSecretDir);
    useSecretStore(destinationSecretDir);
    const destinationApp = authedApp(destination);
    const plan = await preview(destinationApp, exported.content);
    expect(plan.entries).toMatchObject([
      { key: 'alpha', suggestedDecision: 'add', conflicts: [] },
      { key: 'zulu', suggestedDecision: 'add', conflicts: [] },
    ]);
    expect(JSON.stringify(plan)).not.toContain('owner-stdio-sentinel');

    const emptySecretResponse = await destinationApp.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: exported.content,
        previewToken: plan.previewToken,
        decisions: [
          { key: 'alpha', decision: 'add', headers: { Authorization: '' } },
          { key: 'zulu', decision: 'add', secretEnv: { API_TOKEN: '' } },
        ],
      })
    );
    expect(emptySecretResponse.status).toBe(422);

    const applyResponse = await destinationApp.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: exported.content,
        previewToken: plan.previewToken,
        decisions: [
          {
            key: 'alpha',
            decision: 'add',
            headers: { Authorization: 'destination-http-sentinel' },
          },
          {
            key: 'zulu',
            decision: 'add',
            secretEnv: { API_TOKEN: 'destination-stdio-sentinel' },
          },
        ],
      })
    );
    const summary = (await applyResponse.json()) as McpPortabilityApplyResponse;
    expect(applyResponse.status).toBe(200);
    expect(Value.Check(McpPortabilityApplyResponseSchema, summary)).toBe(true);
    expect(summary).toMatchObject({ added: 2, replaced: 0, copied: 0, skipped: 0 });
    expect(JSON.stringify(summary)).not.toContain('destination-http-sentinel');
    expect(JSON.stringify(summary)).not.toContain('destination-stdio-sentinel');

    const listResponse = await destinationApp.handle(jsonRequest('/mcp/servers', 'GET'));
    const list = (await listResponse.json()) as McpServerListResponse;
    expect(list.servers).toMatchObject([
      { slug: 'alpha', headerNames: ['Authorization'] },
      { slug: 'zulu', secretEnvNames: ['API_TOKEN'], env: { LOG_LEVEL: 'debug' } },
    ]);

    const reexportResponse = await destinationApp.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', { all: true })
    );
    const reexported = (await reexportResponse.json()) as ExportMcpServersResponse;
    expect(reexported.content).toBe(exported.content);

    const sourceSecrets = readFileSync(join(secretDir, 'secrets.json'), 'utf8');
    const destinationSecrets = readFileSync(join(destinationSecretDir, 'secrets.json'), 'utf8');
    expect(sourceSecrets).toContain('owner-stdio-sentinel');
    expect(sourceSecrets).not.toContain('destination-stdio-sentinel');
    expect(destinationSecrets).toContain('destination-stdio-sentinel');
    expect(destinationSecrets).not.toContain('owner-stdio-sentinel');
  });

  it('keeps legacy credential-shaped env and URL values out of export', async () => {
    const app = authedApp();
    const stdio = await addServer(app, {
      name: 'Legacy stdio',
      slug: 'legacy-stdio',
      transport: 'stdio',
      command: 'bun',
      env: { LOG_LEVEL: 'debug', API_TOKEN: 'legacy-env-sentinel' },
    });
    const http = await addServer(app, {
      name: 'Legacy HTTP',
      slug: 'legacy-http',
      transport: 'http',
      url: 'https://user:legacy-url-sentinel@mcp.example.com/path',
    });
    const unsafeQuery = await addServer(app, {
      name: 'Query credential',
      slug: 'query-credential',
      transport: 'http',
      url: 'https://mcp.example.com/path?api_key=query-value-sentinel',
    });

    const exportResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', {
        serverIds: [stdio.id, http.id],
      })
    );
    const exported = (await exportResponse.json()) as ExportMcpServersResponse;
    expect(exportResponse.status).toBe(200);
    expect(exported.content).not.toContain('legacy-env-sentinel');
    expect(exported.content).not.toContain('legacy-url-sentinel');
    expect(exported.content).toContain('API_TOKEN');
    expect(exported.content).toContain('Authorization');
    expect(exported.content).toContain('https://mcp.example.com/path');

    const rejectedResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', { serverIds: [unsafeQuery.id] })
    );
    const rejectedText = await rejectedResponse.text();
    expect(rejectedResponse.status).toBe(422);
    expect(rejectedText).not.toContain('query-value-sentinel');
  });

  it('previews exact matches and supports deterministic copy and replace decisions', async () => {
    const app = authedApp();
    const original = await addServer(app, {
      name: 'Remote',
      slug: 'remote',
      transport: 'http',
      url: 'https://old.example.com/mcp',
    });
    const source = JSON.stringify({
      mcpServers: { remote: { type: 'http', url: 'https://new.example.com/mcp' } },
    });

    const copyPlan = await preview(app, source);
    expect(copyPlan.entries[0]).toMatchObject({
      conflicts: [{ serverId: original.id, keys: ['slug', 'name'], exact: false }],
      allowedDecisions: ['skip', 'replace', 'copy'],
      suggestedDecision: 'skip',
      copyName: 'remote copy',
      copySlug: 'remote-copy',
    });
    const copyResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: source,
        previewToken: copyPlan.previewToken,
        decisions: [{ key: 'remote', decision: 'copy' }],
      })
    );
    expect(await copyResponse.json()).toMatchObject({ copied: 1 });

    const replacePlan = await preview(app, source);
    const replaceResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: source,
        previewToken: replacePlan.previewToken,
        decisions: [{ key: 'remote', decision: 'replace', targetServerId: original.id }],
      })
    );
    expect(replaceResponse.status).toBe(200);
    expect(await replaceResponse.json()).toMatchObject({ replaced: 1 });

    const exportedResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/export', 'POST', { all: true })
    );
    const exported = (await exportedResponse.json()) as ExportMcpServersResponse;
    const exactPlan = await preview(app, exported.content);
    expect(exactPlan.entries.every((entry) => entry.suggestedDecision === 'skip')).toBe(true);
    expect(exactPlan.entries.every((entry) => entry.allowedDecisions.length === 1)).toBe(true);
  });

  it('rejects stale previews after source or managed state changes', async () => {
    const app = authedApp();
    const source = JSON.stringify({ mcpServers: { fresh: { command: 'bun' } } });
    const plan = await preview(app, source);
    await addServer(app, {
      name: 'Concurrent',
      slug: 'concurrent',
      transport: 'stdio',
      command: 'bun',
    });

    const staleState = await app.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: source,
        previewToken: plan.previewToken,
        decisions: [{ key: 'fresh', decision: 'add' }],
      })
    );
    const staleSource = await app.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: JSON.stringify({ mcpServers: { changed: { command: 'bun' } } }),
        previewToken: plan.previewToken,
        decisions: [{ key: 'fresh', decision: 'add' }],
      })
    );

    expect(staleState.status).toBe(409);
    expect(staleSource.status).toBe(409);
    const list = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    expect(
      ((await list.json()) as McpServerListResponse).servers.map((server) => server.slug)
    ).toEqual(['concurrent']);
  });

  it('rolls back every row and compensates staged secrets on a multi-entry failure', async () => {
    const app = authedApp();
    const alpha = await addServer(app, {
      name: 'Alpha',
      slug: 'alpha',
      transport: 'http',
      url: 'https://alpha.example.com/mcp',
    });
    const beta = await addServer(app, {
      name: 'Beta',
      slug: 'beta',
      transport: 'http',
      url: 'https://beta.example.com/mcp',
    });
    const source = JSON.stringify({
      mcpServers: {
        good: {
          type: 'http',
          url: 'https://good.example.com/mcp',
          headers: { Authorization: 'Bearer staged-good-sentinel' },
        },
        alpha: {
          type: 'http',
          url: 'https://replacement.example.com/mcp',
          headers: { Authorization: 'Bearer staged-replacement-sentinel' },
        },
      },
      'x-mangostudio': {
        servers: {
          alpha: {
            name: 'Beta',
            enabled: true,
            timeoutMs: null,
            secretEnvNames: [],
            headerNames: [],
          },
        },
      },
    });
    const plan = await preview(app, source);
    const alphaEntry = plan.entries.find((entry) => entry.key === 'alpha');
    expect(alphaEntry?.conflicts.map((candidate) => candidate.serverId).sort()).toEqual(
      [alpha.id, beta.id].sort()
    );

    const applyResponse = await app.handle(
      jsonRequest('/mcp/servers/portability/import/apply', 'POST', {
        json: source,
        previewToken: plan.previewToken,
        decisions: [
          { key: 'good', decision: 'add' },
          { key: 'alpha', decision: 'replace', targetServerId: beta.id },
        ],
      })
    );
    expect(applyResponse.status).toBe(409);

    const listResponse = await app.handle(jsonRequest('/mcp/servers', 'GET'));
    const list = (await listResponse.json()) as McpServerListResponse;
    expect(list.servers.map((server) => server.slug).sort()).toEqual(['alpha', 'beta']);

    const secretFile = join(secretDir, 'secrets.json');
    const stored = existsSync(secretFile) ? readFileSync(secretFile, 'utf8') : '';
    expect(stored).not.toContain('staged-good-sentinel');
    expect(stored).not.toContain('staged-replacement-sentinel');
  });
});
