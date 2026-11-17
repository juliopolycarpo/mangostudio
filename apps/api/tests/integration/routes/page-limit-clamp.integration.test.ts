/**
 * `limit` on the two paged list routes.
 *
 * Both took `limit` as free text and passed whatever integer came out to the
 * query, so one request for `limit=100000` read the whole table into the hub,
 * and a negative `limit` reached SQLite as a negative `LIMIT`, which SQLite
 * reads as no limit at all. Each case below is a request that used to return
 * more rows than the documented maximum, or to ignore its own limit.
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

async function getJson<T>(
  plugin: typeof chatRoutes | typeof messageRoutes,
  path: string
): Promise<T> {
  const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
  restores.push(restore);
  const response = await app.handle(new Request(`http://localhost${path}`));
  if (response.status !== 200) {
    throw new Error(`GET ${path}: expected status: 200 | received: ${response.status}`);
  }
  return (await response.json()) as T;
}

const transcriptCount = async (limit: string) =>
  (await getJson<{ messages: unknown[] }>(chatRoutes, `/chats/${chatId}/messages?limit=${limit}`))
    .messages.length;

const galleryCount = async (limit: string) =>
  (await getJson<{ items: unknown[] }>(messageRoutes, `/messages/images?limit=${limit}`)).items
    .length;

const routes = [
  ['GET /chats/:id/messages', transcriptCount],
  ['GET /messages/images', galleryCount],
] as const;

describe.each(routes)('%s limit', (_name, count) => {
  it('honours a limit inside the range', async () => {
    expect(await count('7')).toBe(7);
  });

  it('serves the default page when limit is absent', async () => {
    expect(await count('')).toBe(LIMIT_DEFAULT);
  });

  it('clamps a limit above the maximum to the maximum', async () => {
    expect(await count(String(LIMIT_MAX + 1))).toBe(LIMIT_MAX);
    expect(await count('100000')).toBe(LIMIT_MAX);
    expect(await count('99999999999999999999')).toBe(LIMIT_MAX);
  });

  it.each(['0', '-1', '-2', '-100000'])(
    'treats limit=%s as no usable limit and serves the default page',
    async (limit) => {
      expect(await count(limit)).toBe(LIMIT_DEFAULT);
    }
  );

  it.each(['abc', '1.5', '12abc', ' '])(
    'treats limit=%p as no usable limit and serves the default page',
    async (limit) => {
      expect(await count(limit)).toBe(LIMIT_DEFAULT);
    }
  );
});
