import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { TerminalAvailability, TerminalSessionResponse } from '@mangostudio/shared/terminal';
import { getDb } from '../../../src/db/database';
import { loadConfigForTest } from '../../../src/lib/config';
import {
  createTerminalSessionService,
  type TerminalSessionService,
} from '../../../src/modules/terminals/application/terminal-session-service';
import type { TerminalRuntimeClient } from '../../../src/modules/terminals/domain/terminal-runtime-client';
import { createTerminalRoutes } from '../../../src/modules/terminals/http/terminal-routes';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  createLocalRuntimeConnector,
  RuntimeConnectionManager,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestChat, insertTestUser } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import {
  FAKE_TERMINAL_MANIFEST,
  FakeTerminalRuntimeClient,
} from '../../support/mocks/fake-terminal-runtime-client';

interface TestUser {
  id: string;
  name: string;
  email: string;
}

let userSeq = 0;
let restoreAuth: (() => void) | null = null;

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function freshUser(prefix: string): TestUser {
  userSeq += 1;
  return {
    id: `${prefix}-${userSeq}`,
    name: `${prefix} user`,
    email: `${prefix}-${userSeq}@mangostudio.test`,
  };
}

function authedApp(routes: ReturnType<typeof createTerminalRoutes>, user: TestUser) {
  restoreAuth?.();
  const { app, restore } = createAuthenticatedApiTestApp(user, routes);
  restoreAuth = restore;
  return app;
}

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('terminal HTTP routes', () => {
  it('rejects unauthenticated requests', async () => {
    const app = createApiTestApp(createTerminalRoutes());

    const response = await app.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID })
    );

    expect(response.status).toBe(401);
  });

  it('refuses to open a terminal when [terminal] is disabled', async () => {
    loadConfigForTest({
      terminal: {
        enabled: false,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      },
    });
    const app = authedApp(createTerminalRoutes(), freshUser('terminal-disabled'));

    const response = await app.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID })
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe(ERROR_CODES.TERMINAL_DISABLED);
  });
});

describe('terminal HTTP routes with a fake runtime', () => {
  let service: TerminalSessionService;
  let client: FakeTerminalRuntimeClient;
  let routes: ReturnType<typeof createTerminalRoutes>;

  beforeEach(() => {
    loadConfigForTest({});
    client = new FakeTerminalRuntimeClient();
    service = createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: () => Promise.resolve(client),
      isIdentityAttested: () => true,
      // resolveChat is left at its default: it queries `getDb()` directly,
      // which is the same connected test database this file uses.
      now: Date.now,
      randomId: () => crypto.randomUUID(),
    });
    routes = createTerminalRoutes(service);
  });

  it('defaults cwd to the chat workdir and stamps MANGOSTUDIO_CHAT_ID', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await getDb()
      .updateTable('chats')
      .set({ workdir: '/repo/chat' })
      .where('id', '=', chat.id)
      .execute();
    const app = authedApp(routes, user);

    const response = await app.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID, chatId: chat.id })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as TerminalSessionResponse;
    expect(body.session.cwd).toBe('/repo/chat');
    expect(body.session.chatId).toBe(chat.id);
    expect(client.calls.open[0]).toMatchObject({
      cwd: '/repo/chat',
      env: { MANGOSTUDIO_CHAT_ID: chat.id },
    });
  });

  it('refuses a chat that belongs to another user with the same response as a missing one', async () => {
    const owner = await insertTestUser();
    const stranger = await insertTestUser();
    const chat = await insertTestChat(owner.id);
    const app = authedApp(routes, stranger);

    const response = await app.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID, chatId: chat.id })
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('lists, renames, and closes a session, each scoped to its owner', async () => {
    const owner = await insertTestUser();
    const stranger = await insertTestUser();
    const ownerApp = authedApp(routes, owner);

    const opened = await ownerApp.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID })
    );
    const { session } = (await opened.json()) as TerminalSessionResponse;

    const listed = await ownerApp.handle(jsonRequest('/terminals', 'GET'));
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);

    const strangerApp = authedApp(routes, stranger);
    const foreignRename = await strangerApp.handle(
      jsonRequest(`/terminals/${session.id}`, 'PATCH', { title: 'Hijacked' })
    );
    expect(foreignRename.status).toBe(404);
    const foreignClose = await strangerApp.handle(
      jsonRequest(`/terminals/${session.id}`, 'DELETE')
    );
    expect(foreignClose.status).toBe(404);

    const ownerAgain = authedApp(routes, owner);
    const renamed = await ownerAgain.handle(
      jsonRequest(`/terminals/${session.id}`, 'PATCH', { title: 'My shell' })
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as TerminalSessionResponse).session.title).toBe('My shell');

    const closed = await ownerAgain.handle(jsonRequest(`/terminals/${session.id}`, 'DELETE'));
    expect(closed.status).toBe(200);
    expect(client.calls.close.map((call) => call.sessionId)).toContain(session.id);
  });

  it('reports availability reasons the schema defines', async () => {
    const user = await insertTestUser();
    const app = authedApp(routes, user);

    const available = await app.handle(
      jsonRequest(`/terminals/availability?environmentId=${LOCAL_ENVIRONMENT_ID}`, 'GET')
    );
    expect(((await available.json()) as TerminalAvailability).available).toBe(true);
  });
});

describe('terminal HTTP routes on a shared Local runtime', () => {
  it('refuses a Local terminal once a second account has connected to the same runtime', async () => {
    loadConfigForTest({});
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: (userId) =>
        Promise.resolve({
          id: LOCAL_ENVIRONMENT_ID,
          userId,
          name: 'Local',
          transportKind: 'in-process',
          config: {},
          enabled: true,
        }),
      connectors: {
        'in-process': createLocalRuntimeConnector({
          open: () =>
            Promise.resolve({
              client: new FakeTerminalRuntimeClient({
                manifest: FAKE_TERMINAL_MANIFEST,
              }) as unknown as RuntimeClient,
              close: () => Promise.resolve(),
            }),
        }),
      },
    });
    const service = createTerminalSessionService({
      getConfig: () => ({
        enabled: true,
        idleTimeoutMinutes: 30,
        maxSessionsPerUser: 8,
        scrollbackKib: 256,
      }),
      getRuntimeClient: (userId, environmentId) =>
        manager.getClient(userId, environmentId) as unknown as Promise<TerminalRuntimeClient>,
      isIdentityAttested: (userId, environmentId) =>
        manager.isIdentityAttested(userId, environmentId),
    });
    const routes = createTerminalRoutes(service);
    const userA = await insertTestUser();
    const userB = await insertTestUser();

    const appA = authedApp(routes, userA);
    const firstOpen = await appA.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID })
    );
    expect(firstOpen.status).toBe(201);

    // A second account connecting to the same Local runtime permanently
    // revokes the single-user attestation the first one held — which drops
    // user A's own connection, so reconnect it (bypassing the backoff the
    // drop just started, the way a deliberate "Connect" press would) before
    // asserting on the isolation guard rather than a transient reconnect delay.
    await manager.getClient(userB.id, LOCAL_ENVIRONMENT_ID);
    await manager.connect(userA.id, LOCAL_ENVIRONMENT_ID, { force: true });

    const appAAgain = authedApp(routes, userA);
    const secondOpen = await appAAgain.handle(
      jsonRequest('/terminals', 'POST', { environmentId: LOCAL_ENVIRONMENT_ID })
    );
    expect(secondOpen.status).toBe(403);
    expect(((await secondOpen.json()) as { code: string }).code).toBe(
      ERROR_CODES.TERMINAL_NOT_ISOLATED
    );
  });
});
