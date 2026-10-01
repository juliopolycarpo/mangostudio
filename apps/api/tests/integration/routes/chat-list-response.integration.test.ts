import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { Updateable } from 'kysely';
import { getDb } from '../../../src/db/database';
import type { Database } from '../../../src/db/types';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/**
 * Wire parity for `GET /chats`.
 *
 * The chat list is the one response every authenticated first screen waits
 * for, so how it is encoded is free to change for speed — what it encodes is
 * not. These tests pin the exact bytes, headers, and failure answer for a
 * fixture that walks every branch of the public projection: both runner kinds,
 * every permission and model axis, all three states of the workdir override,
 * each source of context info, a remote environment, and a title that
 * exercises JSON string escaping. The expected text was captured from the
 * route before its encoding changed; a difference here is a wire change.
 */

type ChatColumns = Omit<Updateable<Database['chats']>, 'id' | 'userId'>;

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

const BASE_TIME = 1_750_000_000_000;

/** Seeds one chat through the shared factory, then sets the columns under test. */
async function seedChat(user: UserFixture, id: string, title: string, columns: ChatColumns) {
  await insertTestChat(user.id, { id, title });
  await getDb().updateTable('chats').set(columns).where('id', '=', id).execute();
}

async function seedRepresentativeChats(user: UserFixture, prefix: string) {
  await seedChat(user, `${prefix}-snapshot`, 'Snapshot context', {
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 5_000,
    model: 'gpt-5',
    textModel: 'gpt-5-mini',
    imageModel: 'imagen-4',
    lastContextState: JSON.stringify({
      estimatedInputTokens: 120_000,
      providerReportedInputTokens: 118_000,
      contextLimit: 200_000,
      estimatedUsageRatio: 0.6,
      mode: 'stateful',
      severity: 'warning',
      lastUpdatedAt: BASE_TIME,
    }),
  });
  await seedChat(user, `${prefix}-legacy`, 'Legacy provider state', {
    createdAt: BASE_TIME + 1,
    updatedAt: BASE_TIME + 4_000,
    model: 'claude-sonnet',
    runnerAgentId: 'user:code-reviewer',
    workdir: '/work/legacy',
    restrictToolsToWorkdir: 1,
    lastProviderState: JSON.stringify({
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-5',
      systemPromptHash: 'hash-a',
      toolsetHash: 'hash-b',
      cursor: 'resp_123',
      context: {
        providerReportedInputTokens: 50_000,
        estimatedInputTokens: 49_000,
        contextLimit: 200_000,
        lastUpdatedAt: BASE_TIME,
      },
    }),
  });
  await seedChat(user, `${prefix}-external`, 'External runner', {
    createdAt: BASE_TIME + 2,
    updatedAt: BASE_TIME + 3_000,
    runnerKind: 'external',
    runnerAgentId: null,
    runnerTargetId: 'codex',
    runnerPermissionLevel: 'full-access',
    runnerApprovalRouting: 'auto-review',
    runnerModel: 'gpt-5-codex',
    runnerEffort: 'high',
    workdir: '/work/external',
    restrictToolsToWorkdir: 0,
    environmentId: 'remote-box',
  });
  await seedChat(user, `${prefix}-unreadable`, 'Olá "mundo" \\   ✓ <tag>', {
    createdAt: BASE_TIME + 3,
    updatedAt: BASE_TIME + 2_000,
    runnerKind: 'external',
    runnerAgentId: null,
    runnerTargetId: 'claude',
    runnerPermissionLevel: 'retired-level',
    runnerModel: '   ',
    lastContextState: '{not json',
    lastProviderState: JSON.stringify({ schemaVersion: 1, mode: 'unknown' }),
  });
}

/** The exact projection the fixture above must produce, newest first. */
function expectedChats(prefix: string) {
  return [
    {
      id: `${prefix}-snapshot`,
      title: 'Snapshot context',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 5_000,
      model: 'gpt-5',
      textModel: 'gpt-5-mini',
      imageModel: 'imagen-4',
      runner: { kind: 'mangostudio', agentId: 'default' },
      runnerPermissions: {},
      runnerModelSelection: {},
      workdir: null,
      environmentId: 'local',
      restrictToolsToWorkdir: null,
      contextInfo: {
        estimatedInputTokens: 120_000,
        contextLimit: 200_000,
        estimatedUsageRatio: 0.6,
        mode: 'stateful',
        severity: 'warning',
      },
    },
    {
      id: `${prefix}-legacy`,
      title: 'Legacy provider state',
      createdAt: BASE_TIME + 1,
      updatedAt: BASE_TIME + 4_000,
      model: 'claude-sonnet',
      textModel: null,
      imageModel: null,
      runner: { kind: 'mangostudio', agentId: 'user:code-reviewer' },
      runnerPermissions: {},
      runnerModelSelection: {},
      workdir: '/work/legacy',
      environmentId: 'local',
      restrictToolsToWorkdir: true,
      contextInfo: {
        estimatedInputTokens: 50_000,
        contextLimit: 200_000,
        estimatedUsageRatio: 0.25,
        mode: 'stateful',
        severity: 'normal',
      },
    },
    {
      id: `${prefix}-external`,
      title: 'External runner',
      createdAt: BASE_TIME + 2,
      updatedAt: BASE_TIME + 3_000,
      model: null,
      textModel: null,
      imageModel: null,
      runner: { kind: 'external', targetId: 'codex' },
      runnerPermissions: { level: 'full-access', routing: 'auto-review' },
      runnerModelSelection: { model: 'gpt-5-codex', effort: 'high' },
      workdir: '/work/external',
      environmentId: 'remote-box',
      restrictToolsToWorkdir: false,
      contextInfo: null,
    },
    {
      id: `${prefix}-unreadable`,
      title: 'Olá "mundo" \\   ✓ <tag>',
      createdAt: BASE_TIME + 3,
      updatedAt: BASE_TIME + 2_000,
      model: null,
      textModel: null,
      imageModel: null,
      runner: { kind: 'external', targetId: 'claude' },
      runnerPermissions: {},
      runnerModelSelection: {},
      workdir: null,
      environmentId: 'local',
      restrictToolsToWorkdir: null,
      contextInfo: null,
    },
  ];
}

/** A probe plugin that writes a response header the way rate limiting and CORS do. */
const headerProbe = new Elysia({ name: 'chat-list-header-probe' }).request(({ set }) => {
  set.headers['x-parity-probe'] = 'kept';
});

function authenticatedApp(user: UserFixture) {
  const { app, restore } = createAuthenticatedApiTestApp(
    user,
    errorHandler,
    headerProbe,
    chatRoutes
  );
  restoreAuth = restore;
  return app;
}

describe('GET /chats wire parity', () => {
  it('encodes a representative list byte for byte as before', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    await seedRepresentativeChats(user, 'parity');
    await seedChat(otherUser, 'parity-foreign', 'Another account', {
      updatedAt: BASE_TIME + 9_000,
    });

    const response = await authenticatedApp(user).handle(new Request('http://localhost/chats'));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toBe(JSON.stringify(expectedChats('parity')));
  });

  it('encodes the same body for chats carrying large continuation state', async () => {
    const user = await insertTestUser();
    const envelope = (cursor: string) =>
      JSON.stringify({
        schemaVersion: 1,
        provider: 'openai-compatible',
        mode: 'responses',
        modelName: 'gpt-5',
        systemPromptHash: 'hash-a',
        toolsetHash: 'hash-b',
        cursor,
        context: {
          estimatedInputTokens: 20_000,
          providerReportedInputTokens: 20_000,
          contextLimit: 100_000,
        },
      });
    const wide = 'w'.repeat(64 * 1024);
    await seedChat(user, 'large-snapshot', 'Snapshot over a large envelope', {
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 3,
      lastProviderState: envelope(wide),
      lastContextState: JSON.stringify({
        estimatedInputTokens: 30_000,
        contextLimit: 100_000,
        estimatedUsageRatio: 0.3,
        mode: 'stateful',
        severity: 'normal',
        lastUpdatedAt: BASE_TIME,
      }),
    });
    await seedChat(user, 'large-legacy', 'Large envelope, no snapshot', {
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 2,
      lastProviderState: envelope(wide),
    });
    await seedChat(user, 'large-stale', 'Large envelope, stale snapshot shape', {
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 1,
      lastProviderState: envelope(wide),
      // Valid JSON from an older shape: no `lastUpdatedAt`, so it is unreadable.
      lastContextState: JSON.stringify({
        estimatedInputTokens: 30_000,
        contextLimit: 100_000,
        estimatedUsageRatio: 0.3,
        mode: 'stateful',
        severity: 'normal',
      }),
    });
    const chat = (id: string, title: string, updatedAt: number, tokens: number, ratio: number) => ({
      id,
      title,
      createdAt: BASE_TIME,
      updatedAt,
      model: null,
      textModel: null,
      imageModel: null,
      runner: { kind: 'mangostudio', agentId: 'default' },
      runnerPermissions: {},
      runnerModelSelection: {},
      workdir: null,
      environmentId: 'local',
      restrictToolsToWorkdir: null,
      contextInfo: {
        estimatedInputTokens: tokens,
        contextLimit: 100_000,
        estimatedUsageRatio: ratio,
        mode: 'stateful',
        severity: 'normal',
      },
    });

    const response = await authenticatedApp(user).handle(new Request('http://localhost/chats'));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toBe(
      JSON.stringify([
        chat('large-snapshot', 'Snapshot over a large envelope', BASE_TIME + 3, 30_000, 0.3),
        chat('large-legacy', 'Large envelope, no snapshot', BASE_TIME + 2, 20_000, 0.2),
        chat('large-stale', 'Large envelope, stale snapshot shape', BASE_TIME + 1, 20_000, 0.2),
      ])
    );
  });

  it('answers with the same headers, including ones set by earlier hooks', async () => {
    const user = await insertTestUser();
    await seedRepresentativeChats(user, 'headers');

    const response = await authenticatedApp(user).handle(new Request('http://localhost/chats'));
    await response.arrayBuffer();

    expect(Object.fromEntries(response.headers.entries())).toEqual({
      'content-type': 'application/json;charset=utf-8',
      'x-parity-probe': 'kept',
    });
  });

  it('encodes an empty list as an empty JSON array', async () => {
    const user = await insertTestUser();

    const response = await authenticatedApp(user).handle(new Request('http://localhost/chats'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[]');
  });

  it('refuses a stored chat that breaks the response contract as a server error', async () => {
    const user = await insertTestUser();
    await seedRepresentativeChats(user, 'invalid');
    // Passes the repository mapper but not `environmentId`'s `minLength: 1`.
    await seedChat(user, 'invalid-environment', 'Empty environment', {
      updatedAt: BASE_TIME + 1_000,
      environmentId: '',
    });

    const response = await authenticatedApp(user).handle(new Request('http://localhost/chats'));

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 500,
      body: { error: 'An internal error occurred', code: 'INTERNAL' },
    });
  });
});
