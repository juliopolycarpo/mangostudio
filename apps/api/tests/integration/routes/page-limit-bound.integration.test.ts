/**
 * `limit` on the two paged list routes.
 *
 * Both took `limit` as free text and passed whatever integer came out to the
 * query, so one request for `limit=100000` read the whole table into the hub,
 * and a negative `limit` reached SQLite as a negative `LIMIT`, which SQLite
 * reads as no limit at all. The schema now bounds it to 1..maximum and answers
 * 422 otherwise, like the activity, GitHub and external-session routes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@mangostudio/shared/chat';

import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { messageRoutes } from '../../../src/modules/messages/http/message-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const LIMIT_DEFAULT = PAGE_LIMIT_DEFAULT;
const LIMIT_MAX = PAGE_LIMIT_MAX;
/** More rows than the maximum, so an unclamped limit is visible. */
const ROW_COUNT = LIMIT_MAX + 30;
const BASE_TIMESTAMP = 1_700_000_000_000;

let user!: UserFixture;
let chatId = '';
const restores: (() => void)[] = [];

beforeEach(async () => {
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  const ids = Array.from({ length: ROW_COUNT }, (_, index) => `${user.id.slice(-12)}-${index}`);
  await getDb()
    .insertInto('messages')
    .values(
      ids.map((id, index) => ({
        id,
        chatId,
        role: 'ai' as const,
        text: id,
        imageUrl: `/uploads/${id}.png`,
        timestamp: BASE_TIMESTAMP + index,
        isGenerating: 0,
        interactionMode: 'image' as const,
      }))
    )
    .execute();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

async function getLimit(
  plugin: typeof chatRoutes | typeof messageRoutes,
  path: string
): Promise<Response> {
  const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
  restores.push(restore);
  return app.handle(new Request(`http://localhost${path}`));
}

const transcriptPath = (limit: string) =>
  `/chats/${chatId}/messages${limit === '' ? '' : `?limit=${limit}`}`;
const galleryPath = (limit: string) => `/messages/images${limit === '' ? '' : `?limit=${limit}`}`;

const routes = [
  ['GET /chats/:id/messages', chatRoutes, transcriptPath, 'messages'],
  ['GET /messages/images', messageRoutes, galleryPath, 'items'],
] as const;

describe.each(routes)('%s limit', (_name, plugin, pathFor, rowsKey) => {
  const count = async (limit: string) => {
    const response = await getLimit(plugin, pathFor(limit));
    if (response.status !== 200) {
      throw new Error(`limit=${limit}: expected status: 200 | received: ${response.status}`);
    }
    return ((await response.json()) as Record<string, unknown[]>)[rowsKey]?.length;
  };

  it('honours a limit inside the range, up to the maximum', async () => {
    expect(await count('7')).toBe(7);
    expect(await count(String(LIMIT_MAX))).toBe(LIMIT_MAX);
  });

  it('serves the default page when limit is absent', async () => {
    expect(await count('')).toBe(LIMIT_DEFAULT);
  });

  it.each(['101', '100000', '99999999999999999999', '0', '-1', '-100000', 'abc', '1.5', '12abc'])(
    'refuses limit=%s with 422 and the range it allows',
    async (limit) => {
      const response = await getLimit(plugin, pathFor(limit));
      expect(
        response.status,
        `limit=${limit}: expected status: 422 (limit must be 1..${LIMIT_MAX}) | received: ${response.status}`
      ).toBe(422);
    }
  );
});
