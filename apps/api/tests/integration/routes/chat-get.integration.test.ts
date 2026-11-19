import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '@mangostudio/shared/errors';

import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/**
 * `GET /chats/:id`: one chat of the caller by id, so a client holding only part
 * of the paged list can still open a chat outside it.
 */

let user!: UserFixture;
let restoreAuth: (() => void) | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'] | null = null;

beforeEach(async () => {
  user = await insertTestUser();
  const created = createAuthenticatedApiTestApp(user, errorHandler, chatRoutes);
  app = created.app;
  restoreAuth = created.restore;
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  app = null;
});

function liveApp() {
  if (!app) throw new Error('(chat-get): expected a test app: created | received: null');
  return app;
}

async function getChat(id: string) {
  const response = await liveApp().handle(new Request(`http://localhost/chats/${id}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /chats/:id', () => {
  it('returns the chat as the list shows it, without persistence-only fields', async () => {
    const chat = await insertTestChat(user.id, { title: 'Deep in history' });
    await getDb()
      .updateTable('chats')
      .set({ workdir: '/srv/projects/mango', updatedAt: 1 })
      .where('id', '=', chat.id)
      .execute();

    const found = await getChat(chat.id);

    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      id: chat.id,
      title: 'Deep in history',
      workdir: '/srv/projects/mango',
      environmentId: 'local',
      runner: { kind: 'mangostudio', agentId: 'default' },
    });
    expect(found.body).not.toHaveProperty('userId');
    expect(found.body).not.toHaveProperty('lastProviderState');
    expect(found.body).not.toHaveProperty('lastContextState');
  });

  it('answers 404 NOT_FOUND for a chat that does not exist', async () => {
    const missing = await getChat('no-such-chat');

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
  });

  it('answers the same 404 for another account, so ownership is not revealed', async () => {
    const other = await insertTestUser();
    const theirs = await insertTestChat(other.id, { title: 'Not yours' });

    const found = await getChat(theirs.id);

    expect(found.status).toBe(404);
    expect(found.body).toEqual({ error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
  });
});
