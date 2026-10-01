import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

/**
 * `GET /chats/:id/messages?order=desc` pages from the newest end.
 *
 * Each returned page stays chronological (oldest row first) whatever the
 * order: `order` picks which window of the transcript a page is, and
 * `nextCursor` always points at the edge of that window facing the rows not
 * read yet. The 120-row fixture has timestamp ties that straddle the page
 * boundaries of a 50-row window read from either end.
 */

const BASE_TIMESTAMP = 1_700_000_000_000;
const TOTAL = 120;
const PAGE_SIZE = 50;

interface PageBody {
  messages: { id: string }[];
  nextCursor: string | null;
}

type Order = 'asc' | 'desc';

let TEST_USER!: UserFixture;
const authRestores: (() => void)[] = [];

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

afterEach(() => {
  while (authRestores.length > 0) authRestores.pop()?.();
});

/** Message ids are global, so each chat's rows carry the chat id: `<chat>-ord-007`. */
function messageId(chatId: string, position: number): string {
  return `${chatId}-ord-${String(position).padStart(3, '0')}`;
}

/**
 * Reads a page as the 1-based fixture positions it holds, collapsing runs:
 * `[71..120]` reads `71-120`, a page that skipped row 5 reads `1-4,6-10`. A wrong
 * page then fails as `expected rows: 71-120 | received: 1-50`, not as a 50-line diff.
 */
function describeRows(chatId: string, page: PageBody): string {
  const prefix = `${chatId}-ord-`;
  const positions = page.messages.map((message) =>
    message.id.startsWith(prefix) ? Number(message.id.slice(prefix.length)) : Number.NaN
  );
  const runs: string[] = [];
  for (let index = 0; index < positions.length; ) {
    let end = index;
    while (positions[end + 1] === (positions[end] ?? 0) + 1) end++;
    runs.push(end === index ? `${positions[index]}` : `${positions[index]}-${positions[end]}`);
    index = end + 1;
  }
  return runs.join(',');
}

function expectRows(chatId: string, page: PageBody, expected: string) {
  const received = describeRows(chatId, page);
  if (received === expected) return;
  throw new Error(`expected rows: ${expected} | received: ${received}`);
}

/**
 * Runs of rows sharing one timestamp. A 50-row page cut from the oldest end
 * ends between rows 50|51 and 100|101, one cut from the newest end between
 * 70|71 and 20|21: each cut falls inside a tie.
 */
const TIE_GROUPS: ReadonlyArray<readonly [first: number, last: number]> = [
  [17, 24],
  [47, 53],
  [67, 74],
  [98, 104],
];

function timestampOf(position: number): number {
  const group = TIE_GROUPS.find(([first, last]) => position >= first && position <= last);
  return BASE_TIMESTAMP + (group ? group[0] : position);
}

/** Inserts in chronological order, so `rowid` order breaks every tie as the position does. */
async function seedTranscript(chatId: string, positions = TOTAL) {
  await getDb()
    .insertInto('messages')
    .values(
      Array.from({ length: positions }, (_, index) => ({
        id: messageId(chatId, index + 1),
        chatId,
        role: 'user' as const,
        text: `row ${index + 1}`,
        timestamp: timestampOf(index + 1),
        isGenerating: 0,
        interactionMode: 'chat' as const,
      }))
    )
    .execute();
}

async function newChat(): Promise<string> {
  const chat = await insertTestChat(TEST_USER.id);
  return chat.id;
}

function rawGet(chatId: string, query: string) {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
  authRestores.push(restore);
  return app.handle(new Request(`http://localhost/chats/${chatId}/messages?${query}`));
}

function pageQuery(order: Order | null, cursor: string | null, limit: number): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (order) query.set('order', order);
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}

async function fetchPage(
  chatId: string,
  order: Order | null,
  cursor: string | null = null,
  limit = PAGE_SIZE
): Promise<PageBody> {
  const response = await rawGet(chatId, pageQuery(order, cursor, limit));
  if (response.status !== 200) {
    throw new Error(
      `expected status: 200 | received: ${response.status} for order=${order} cursor=${cursor}`
    );
  }
  return (await response.json()) as PageBody;
}

async function readAllPages(chatId: string, order: Order | null, limit: number) {
  const pages: PageBody[] = [];
  let cursor: string | null = null;
  do {
    const page: PageBody = await fetchPage(chatId, order, cursor, limit);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

/** Every row exactly once, newest page first, each page chronological. */
function expectedDescPages(limit: number): string[] {
  const pages: string[] = [];
  for (let last = TOTAL; last > 0; last -= limit) {
    const first = Math.max(1, last - limit + 1);
    pages.push(first === last ? `${last}` : `${first}-${last}`);
  }
  return pages;
}

describe('GET /chats/:id/messages?order=desc', () => {
  it('opens on the newest rows, chronological inside the page', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const page = await fetchPage(chatId, 'desc');

    expectRows(chatId, page, '71-120');
    expect(page.nextCursor).not.toBeNull();
  });

  it('pages back to the first row, every row exactly once, newest page first', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const pages = await readAllPages(chatId, 'desc', PAGE_SIZE);

    expect(pages.map((page) => describeRows(chatId, page))).toEqual(expectedDescPages(PAGE_SIZE));
    expect(pages.at(-1)?.nextCursor).toBeNull();
  });

  it.each([[1], [7], [13], [47], [60], [119], [120], [500]])(
    'reads each row exactly once with a page size of %d across the ties',
    async (limit) => {
      const chatId = await newChat();
      await seedTranscript(chatId);

      const pages = await readAllPages(chatId, 'desc', limit);

      expect(pages.map((page) => describeRows(chatId, page))).toEqual(expectedDescPages(limit));
    }
  );

  it('ends on null when the last page holds exactly one page of rows', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const pages = await readAllPages(chatId, 'desc', 60);

    expect(pages.map((page) => page.messages.length)).toEqual([60, 60]);
    expect(pages.map((page) => page.nextCursor === null)).toEqual([false, true]);
  });

  it('is not disturbed by rows inserted after the first page was read', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId, 100);

    const first = await fetchPage(chatId, 'desc');
    await getDb()
      .insertInto('messages')
      .values({
        id: `${chatId}-late`,
        chatId,
        role: 'user' as const,
        text: 'late',
        timestamp: BASE_TIMESTAMP + 10_000,
        isGenerating: 0,
        interactionMode: 'chat' as const,
      })
      .execute();
    const second = await fetchPage(chatId, 'desc', first.nextCursor);

    expectRows(chatId, second, '1-50');
  });

  it('keeps paging when the cursor row is deleted between pages', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const first = await fetchPage(chatId, 'desc');
    const oldestSeen = first.messages[0]?.id ?? '';
    await getDb().deleteFrom('messages').where('id', '=', oldestSeen).execute();
    const second = await fetchPage(chatId, 'desc', first.nextCursor);

    expectRows(chatId, second, '21-70');
  });

  it('sends rows in the same wire shape as asc: a transcript that fits one page is the same bytes', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId, 5);

    const asc = await (await rawGet(chatId, pageQuery('asc', null, PAGE_SIZE))).text();
    const desc = await (await rawGet(chatId, pageQuery('desc', null, PAGE_SIZE))).text();

    expect(desc).toBe(asc);
  });

  it('returns an empty first page for an empty chat', async () => {
    const chatId = await newChat();

    const page = await fetchPage(chatId, 'desc');

    expect(page.messages).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('GET /chats/:id/messages?order=asc', () => {
  it('answers byte for byte as a request without an order does', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const defaulted = await readRawPages(chatId, null);
    const explicit = await readRawPages(chatId, 'asc');

    expect(explicit).toEqual(defaulted);
    expect(defaulted).toHaveLength(3);
  });

  it('pages oldest first, chronological inside each page, as before', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const pages = await readAllPages(chatId, null, PAGE_SIZE);

    expect(pages.map((page) => describeRows(chatId, page))).toEqual(['1-50', '51-100', '101-120']);
  });

  async function readRawPages(chatId: string, order: Order | null): Promise<string[]> {
    const bodies: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await rawGet(chatId, pageQuery(order, cursor, PAGE_SIZE));
      const text = await response.text();
      bodies.push(text);
      cursor = (JSON.parse(text) as PageBody).nextCursor;
    } while (cursor);
    return bodies;
  }
});

describe('GET /chats/:id/messages cursors in both orders', () => {
  it.each<Order>(['asc', 'desc'])('refuses an empty cursor with order=%s', async (order) => {
    const chatId = await newChat();
    await seedTranscript(chatId, 3);

    const response = await rawGet(chatId, `order=${order}&cursor=`);
    const body = (await response.json()) as { error?: string; code?: string };

    expect(`status ${response.status} code ${body.code}`).toBe('status 400 code VALIDATION');
    expect(body.error).toContain('expected shape: <timestamp>:<rowid>');
  });

  it.each<Order>(['asc', 'desc'])('refuses a malformed cursor with order=%s', async (order) => {
    const chatId = await newChat();
    await seedTranscript(chatId, 3);

    const response = await rawGet(chatId, `order=${order}&cursor=not-a-cursor`);
    const body = (await response.json()) as { error?: string; code?: string };

    expect(`status ${response.status} code ${body.code}`).toBe('status 400 code VALIDATION');
    expect(body.error).toContain('"not-a-cursor"');
  });

  it('reads a bare numeric cursor as after every row of that timestamp when paging asc', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const page = await fetchPage(chatId, 'asc', String(timestampOf(47)), 3);

    expectRows(chatId, page, '54-56');
  });

  it('reads a bare numeric cursor as before every row of that timestamp when paging desc', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const page = await fetchPage(chatId, 'desc', String(timestampOf(47)), 3);

    expectRows(chatId, page, '44-46');
  });

  it('treats a cursor as a position, whichever order issued it', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId);

    const ascFirst = await fetchPage(chatId, 'asc', null, 10);
    const asDesc = await fetchPage(chatId, 'desc', ascFirst.nextCursor, 3);
    const descFirst = await fetchPage(chatId, 'desc', null, 10);
    const asAsc = await fetchPage(chatId, 'asc', descFirst.nextCursor, 3);

    // An asc cursor names the 10th row; read newest first it means "rows before the 10th".
    expectRows(chatId, asDesc, '7-9');
    // A desc cursor names the 111th row; read oldest first it means "rows after the 111th".
    expectRows(chatId, asAsc, '112-114');
  });

  it('refuses an unknown order instead of falling back to a default', async () => {
    const chatId = await newChat();
    await seedTranscript(chatId, 3);

    const response = await rawGet(chatId, 'order=newest');

    // A query the schema rejects is a 422 (the app's error handler adds the
    // VALIDATION code; this harness mounts the route without it), unlike a
    // cursor the use case rejects, which is a 400.
    expect(`status ${response.status}`).toBe('status 422');
  });
});
