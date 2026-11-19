import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';

import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/**
 * Keyset paging of `GET /chats`.
 *
 * The list order is `updatedAt DESC, rowid ASC`, and a cursor names the last
 * chat of a page by that pair. Each test seeds explicit `updatedAt` values so
 * the order is fixed, then walks the pages the way the sidebar does.
 */

const BASE_TIME = 1_750_000_000_000;

interface PageBody {
  items: { id: string; title: string; updatedAt: number }[];
  nextCursor: string | null;
}

let user!: UserFixture;
let tag = '';
let restoreAuth: (() => void) | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'] | null = null;

beforeEach(async () => {
  user = await insertTestUser();
  tag = user.id.slice(-12);
  const created = createAuthenticatedApiTestApp(user, errorHandler, chatRoutes);
  app = created.app;
  restoreAuth = created.restore;
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  app = null;
});

/** Chat ids are global, so every id a test seeds carries this test's tag. */
function uid(name: string): string {
  return `${tag}-${name}`;
}

/** Inserts chats in the given order, so rowid order is the order of `updatedAts`. */
async function seedChats(owner: UserFixture, entries: { name: string; updatedAt: number }[]) {
  for (const { name, updatedAt } of entries) {
    await insertTestChat(owner.id, { id: uid(name), title: name });
    await getDb().updateTable('chats').set({ updatedAt }).where('id', '=', uid(name)).execute();
  }
}

function liveApp() {
  if (!app) throw new Error('(chat-list-cursor): expected a test app: created | received: null');
  return app;
}

async function getPage(query = ''): Promise<{ status: number; body: PageBody }> {
  const response = await liveApp().handle(new Request(`http://localhost/chats${query}`));
  return { status: response.status, body: (await response.json()) as PageBody };
}

/** The URL-encoded cursor a page handed back; a page with none ends the walk, so a test that wants one fails here. */
function cursorOf(page: { body: PageBody }): string {
  const { nextCursor } = page.body;
  if (nextCursor === null) {
    throw new Error(
      `(chat-list-cursor): expected a nextCursor | received: ${JSON.stringify(page.body)}`
    );
  }
  return encodeURIComponent(nextCursor);
}

/** Reads every page with `limit`, returning the ids in the order served and the page count. */
async function walkPages(limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { status, body } = await getPage(query);
    expect(status, `(GET /chats${query}): expected status 200`).toBe(200);
    expect(
      Array.isArray(body.items),
      `(GET /chats${query}): expected a page { items, nextCursor } | received: ${JSON.stringify(body).slice(0, 80)}`
    ).toBe(true);
    ids.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
    pages += 1;
    expect(pages, `(walkPages): expected the walk to end | received ${pages} pages`).toBeLessThan(
      50
    );
  } while (cursor);
  return { ids, pages };
}

describe('GET /chats keyset paging', () => {
  it('serves the list in pages that join into the whole list, newest first', async () => {
    await seedChats(
      user,
      Array.from({ length: 7 }, (_, index) => ({
        name: `c${index}`,
        updatedAt: BASE_TIME + index * 1_000,
      }))
    );

    const { ids, pages } = await walkPages(3);

    expect(ids).toEqual([6, 5, 4, 3, 2, 1, 0].map((index) => uid(`c${index}`)));
    expect(pages).toBe(3);
  });

  it('answers a null cursor on the last page, also when the list is an exact multiple of the limit', async () => {
    await seedChats(
      user,
      Array.from({ length: 6 }, (_, index) => ({
        name: `c${index}`,
        updatedAt: BASE_TIME + index,
      }))
    );

    const first = await getPage('?limit=3');
    const second = await getPage(`?limit=3&cursor=${cursorOf(first)}`);

    expect(first.body.nextCursor).not.toBeNull();
    expect(second.body.items).toHaveLength(3);
    expect(second.body.nextCursor).toBeNull();
  });

  it('answers an empty first page, with no cursor, for an account without chats', async () => {
    const { status, body } = await getPage();

    expect(status).toBe(200);
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it('keeps creation order for chats that share a millisecond across a page boundary', async () => {
    // Six chats tied on one timestamp: the page boundary falls inside the tie.
    await seedChats(
      user,
      Array.from({ length: 6 }, (_, index) => ({ name: `tied${index}`, updatedAt: BASE_TIME }))
    );

    const { ids } = await walkPages(2);

    expect(ids).toEqual([0, 1, 2, 3, 4, 5].map((index) => uid(`tied${index}`)));
  });

  it('continues after a deleted cursor row without skipping or repeating a chat', async () => {
    await seedChats(
      user,
      Array.from({ length: 6 }, (_, index) => ({
        name: `c${index}`,
        updatedAt: BASE_TIME + index * 1_000,
      }))
    );

    const first = await getPage('?limit=2');
    expect(first.body.items.map((item) => item.id)).toEqual([uid('c5'), uid('c4')]);
    // The cursor names c4. Delete it and a chat further down, then read on.
    await getDb()
      .deleteFrom('chats')
      .where('id', 'in', [uid('c4'), uid('c1')])
      .execute();

    const rest = await walkPages(2);
    const second = await getPage(`?limit=2&cursor=${cursorOf(first)}`);

    expect(second.body.items.map((item) => item.id)).toEqual([uid('c3'), uid('c2')]);
    expect(rest.ids).toEqual([uid('c5'), uid('c3'), uid('c2'), uid('c0')]);
  });

  it('leaves later pages alone when a chat is created while paging', async () => {
    await seedChats(
      user,
      Array.from({ length: 4 }, (_, index) => ({
        name: `c${index}`,
        updatedAt: BASE_TIME + index * 1_000,
      }))
    );

    const first = await getPage('?limit=2');
    await seedChats(user, [{ name: 'fresh', updatedAt: BASE_TIME + 99_000 }]);
    const second = await getPage(`?limit=2&cursor=${cursorOf(first)}`);
    const restarted = await getPage('?limit=2');

    // Without a keyset the new chat would shift every row one place and repeat c2.
    expect(second.body.items.map((item) => item.id)).toEqual([uid('c1'), uid('c0')]);
    expect(restarted.body.items.map((item) => item.id)).toEqual([uid('fresh'), uid('c3')]);
  });

  it('does not repeat a chat served earlier that is bumped to the top while paging', async () => {
    await seedChats(
      user,
      Array.from({ length: 4 }, (_, index) => ({
        name: `c${index}`,
        updatedAt: BASE_TIME + index * 1_000,
      }))
    );

    const first = await getPage('?limit=2');
    // c3 was on page one. A turn finishing bumps it; it sorts before the cursor still.
    await getDb()
      .updateTable('chats')
      .set({ updatedAt: BASE_TIME + 50_000 })
      .where('id', '=', uid('c3'))
      .execute();
    const second = await getPage(`?limit=2&cursor=${cursorOf(first)}`);

    expect(second.body.items.map((item) => item.id)).toEqual([uid('c1'), uid('c0')]);
  });

  it('pages one account only', async () => {
    const other = await insertTestUser();
    await seedChats(user, [{ name: 'mine', updatedAt: BASE_TIME }]);
    await insertTestChat(other.id, { id: uid('theirs'), title: 'theirs' });

    const { ids } = await walkPages(5);

    expect(ids).toEqual([uid('mine')]);
  });

  it('serves PAGE_LIMIT_DEFAULT chats when no limit is given', async () => {
    const count = PAGE_LIMIT_DEFAULT + 5;
    await seedChats(
      user,
      Array.from({ length: count }, (_, index) => ({
        name: `c${index}`,
        updatedAt: BASE_TIME + index,
      }))
    );

    const { body } = await getPage();

    expect(body.items).toHaveLength(PAGE_LIMIT_DEFAULT);
    expect(body.nextCursor).not.toBeNull();
  });

  it.each(['abc', '1750000000000', '1750000000000:x', ':5', '1750000000000:5:7'])(
    'rejects the cursor %p with a 400 that names the expected shape',
    async (cursor) => {
      const { status, body } = await getPage(`?cursor=${encodeURIComponent(cursor)}`);

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: ERROR_CODES.VALIDATION });
      expect(JSON.stringify(body)).toContain('<updatedAt>:<rowid>');
    }
  );

  it.each([0, -1, PAGE_LIMIT_MAX + 1, 1.5])('refuses limit=%p with a 422', async (limit) => {
    const response = await liveApp().handle(new Request(`http://localhost/chats?limit=${limit}`));

    expect(response.status).toBe(422);
  });
});
