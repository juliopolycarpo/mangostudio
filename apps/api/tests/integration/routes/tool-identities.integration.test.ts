import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type ToolIdentityListResponse,
  ToolIdentityListResponseSchema,
  type ToolIdentityUpdateResponse,
} from '@mangostudio/shared/tool-identity';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { toolIdentityRoutes } from '../../../src/modules/tool-identity/http/tool-identity-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

// The in-memory database is shared across the process, so each test gets a
// fresh user id rather than trying to clean up after the previous one.
let userSeq = 0;
let testUser: { id: string; name: string; email: string };
let restoreAuth: (() => void) | null = null;

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function mountApp() {
  const { app, restore } = createAuthenticatedApiTestApp(
    testUser,
    errorHandler,
    toolIdentityRoutes
  );
  restoreAuth = restore;
  return app;
}

async function seedMcpServer(userId: string, slug: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id: `${userId}-${slug}`,
      userId,
      name: `Server ${slug}`,
      slug,
      transport: 'stdio',
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: 1,
      timeoutMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

beforeEach(() => {
  userSeq += 1;
  testUser = {
    id: `tool-identity-user-${userSeq}`,
    name: 'Tool Identity User',
    email: `tool-identity-${userSeq}@mangostudio.test`,
  };
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('tool identity routes', () => {
  it('starts empty and round-trips an upsert', async () => {
    const app = mountApp();

    const empty = await app.handle(new Request('http://localhost/tool-identities'));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ identities: {} });

    const written = await app.handle(
      jsonRequest('/tool-identities/agent:claude', 'PUT', { displayName: 'CC', monogram: 'cc' })
    );
    expect(written.status).toBe(200);

    const { identity } = (await written.json()) as ToolIdentityUpdateResponse;
    expect(identity?.subjectKey).toBe('agent:claude');
    expect(identity?.displayName).toBe('CC');
    // Monograms are stored uppercased so every avatar renders the same way
    // regardless of how the user typed it.
    expect(identity?.monogram).toBe('CC');

    const listed = await app.handle(new Request('http://localhost/tool-identities'));
    const body = (await listed.json()) as ToolIdentityListResponse;
    expect(Value.Check(ToolIdentityListResponseSchema, body)).toBe(true);
    expect(body.identities['agent:claude']?.displayName).toBe('CC');
  });

  it('trims a display name and keeps untouched fields on a partial update', async () => {
    const app = mountApp();

    await app.handle(
      jsonRequest('/tool-identities/runtime:bun', 'PUT', {
        displayName: '  Bun  ',
        monogram: 'BN',
      })
    );
    const patched = await app.handle(
      jsonRequest('/tool-identities/runtime:bun', 'PUT', { displayName: 'Bun 1.x' })
    );

    const { identity } = (await patched.json()) as ToolIdentityUpdateResponse;
    expect(identity?.displayName).toBe('Bun 1.x');
    expect(identity?.monogram).toBe('BN');
  });

  it('resets one field to its default while keeping the other', async () => {
    const app = mountApp();

    await app.handle(
      jsonRequest('/tool-identities/version-manager:nvm', 'PUT', {
        displayName: 'Node Manager',
        monogram: 'NM',
      })
    );
    const cleared = await app.handle(
      jsonRequest('/tool-identities/version-manager:nvm', 'PUT', { monogram: null })
    );

    const { identity } = (await cleared.json()) as ToolIdentityUpdateResponse;
    expect(identity?.displayName).toBe('Node Manager');
    expect(identity?.monogram).toBeNull();
  });

  it('drops the row when an update clears every field', async () => {
    const app = mountApp();

    await app.handle(
      jsonRequest('/tool-identities/agent:codex', 'PUT', { displayName: 'CX', monogram: 'CX' })
    );
    const cleared = await app.handle(
      jsonRequest('/tool-identities/agent:codex', 'PUT', { displayName: null, monogram: null })
    );

    expect(((await cleared.json()) as ToolIdentityUpdateResponse).identity).toBeNull();

    const listed = await app.handle(new Request('http://localhost/tool-identities'));
    expect((await listed.json()) as ToolIdentityListResponse).toEqual({ identities: {} });
  });

  it('resets an identity back to its defaults', async () => {
    const app = mountApp();

    await app.handle(jsonRequest('/tool-identities/agent:cursor', 'PUT', { displayName: 'Cur' }));
    const reset = await app.handle(jsonRequest('/tool-identities/agent:cursor', 'DELETE'));
    expect(reset.status).toBe(204);

    const listed = await app.handle(new Request('http://localhost/tool-identities'));
    expect((await listed.json()) as ToolIdentityListResponse).toEqual({ identities: {} });
  });

  it('rejects an id that is not a member of its kind', async () => {
    const app = mountApp();

    const response = await app.handle(
      jsonRequest('/tool-identities/agent:not-an-agent', 'PUT', { displayName: 'Nope' })
    );

    expect(response.status).toBe(422);
  });

  it('rejects a subject key whose kind is unknown', async () => {
    const app = mountApp();

    const response = await app.handle(
      jsonRequest('/tool-identities/plugin:whatever', 'PUT', { displayName: 'Nope' })
    );

    expect(response.status).toBe(422);
  });

  it('rejects a monogram longer than two characters', async () => {
    const app = mountApp();

    const response = await app.handle(
      jsonRequest('/tool-identities/runtime:node', 'PUT', { monogram: 'NODE' })
    );

    expect(response.status).toBe(422);
  });

  it('accepts an mcp slug the caller owns and rejects one it does not', async () => {
    await seedMcpServer(testUser.id, 'weather');
    const app = mountApp();

    const owned = await app.handle(
      jsonRequest('/tool-identities/mcp:weather', 'PUT', { displayName: 'Weather' })
    );
    expect(owned.status).toBe(200);

    const foreign = await app.handle(
      jsonRequest('/tool-identities/mcp:someone-elses', 'PUT', { displayName: 'Nope' })
    );
    expect(foreign.status).toBe(422);
  });

  it('keeps identities isolated per user', async () => {
    const app = mountApp();
    await app.handle(jsonRequest('/tool-identities/agent:claude', 'PUT', { displayName: 'Mine' }));
    restoreAuth?.();

    const otherUser = {
      id: `tool-identity-other-${userSeq}`,
      name: 'Other User',
      email: `tool-identity-other-${userSeq}@mangostudio.test`,
    };
    const { app: otherApp, restore } = createAuthenticatedApiTestApp(
      otherUser,
      errorHandler,
      toolIdentityRoutes
    );
    restoreAuth = restore;

    const listed = await otherApp.handle(new Request('http://localhost/tool-identities'));
    expect((await listed.json()) as ToolIdentityListResponse).toEqual({ identities: {} });
  });
});
