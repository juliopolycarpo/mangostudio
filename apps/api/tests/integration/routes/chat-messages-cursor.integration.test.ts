import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TIED_TIMESTAMP = 1_700_000_000_000;
const PAGE_SIZE = 50;

interface PageBody {
  messages: { id: string }[];
  nextCursor: string | null;
}

let TEST_USER!: UserFixture;
/** Every authenticated app patches `getSession` over the previous patch, so each one is undone, newest first. */
const authRestores: (() => void)[] = [];

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

afterEach(() => {
  while (authRestores.length > 0) authRestores.pop()?.();
});

async function insertMessages(chatId: string, rows: { id: string; timestamp: number }[]) {
  await getDb()
    .insertInto('messages')
    .values(
      rows.map((row) => ({
        id: row.id,
        chatId,
        role: 'user' as const,
        text: row.id,
        timestamp: row.timestamp,
        isGenerating: 0,
        interactionMode: 'chat' as const,
      }))
    )
    .execute();
}

/**
 * Seeds `count` rows sharing one timestamp. Ids are generated in descending
 * order so the insertion order (rowid) and the id order disagree.
 */
function tiedRows(prefix: string, count: number, timestamp = TIED_TIMESTAMP) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(count - index).padStart(3, '0')}`,
    timestamp,
  }));
}

async function newChat(): Promise<string> {
  const chat = await insertTestChat(TEST_USER.id);
  return chat.id;
}

async function fetchPage(chatId: string, cursor?: string | null, limit = PAGE_SIZE) {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
  authRestores.push(restore);
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const response = await app.handle(
    new Request(`http://localhost/chats/${chatId}/messages?${query}`)
  );
  if (response.status !== 200) {
    throw new Error(`expected status: 200 | received: ${response.status}`);
  }
  return (await response.json()) as PageBody;
}

async function readAll(chatId: string, limit = PAGE_SIZE): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: PageBody = await fetchPage(chatId, cursor, limit);
    ids.push(...page.messages.map((message) => message.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

function expectSize(label: string, expected: number, received: number) {
  if (expected === received) return;
  throw new Error(`expected ${label}: ${expected} messages | received: ${received}`);
}

describe('GET /chats/:id/messages tie-safe cursor', () => {
  it('returns every row of a 60-row timestamp tie across two pages', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, tiedRows('tie', 60));

    const first = await fetchPage(chatId);
    expectSize('first page', 50, first.messages.length);

    const second = await fetchPage(chatId, first.nextCursor);
    expectSize('second page', 10, second.messages.length);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.messages, ...second.messages].map((message) => message.id);
    expect(new Set(ids).size).toBe(60);
  });

  it('returns tied rows in the order an unpaged read returns them', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, tiedRows('order', 60));

    const unpaged = await fetchPage(chatId, null, 100);
    const paged = await readAll(chatId, 7);

    expect(paged).toEqual(unpaged.messages.map((message) => message.id));
  });

  it('returns rows inserted between pages exactly once', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, tiedRows('ins', 60));

    const first = await fetchPage(chatId);
    await insertMessages(chatId, tiedRows('late', 5));
    const second = await fetchPage(chatId, first.nextCursor);

    const ids = [...first.messages, ...second.messages].map((message) => message.id);
    expectSize('combined pages', 65, ids.length);
    expect(new Set(ids).size).toBe(65);
  });

  it('keeps paging when the cursor row and later rows are deleted between pages', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, tiedRows('del', 60));

    const first = await fetchPage(chatId);
    const lastSeen = first.messages.at(-1)?.id ?? '';
    const unpaged = (await fetchPage(chatId, null, 100)).messages.map((message) => message.id);
    const deleted = [lastSeen, unpaged[52], unpaged[55]];
    await getDb().deleteFrom('messages').where('id', 'in', deleted).execute();

    const second = await fetchPage(chatId, first.nextCursor);

    const expectedRest = unpaged.slice(PAGE_SIZE).filter((id) => !deleted.includes(id));
    expect(second.messages.map((message) => message.id)).toEqual(expectedRest);
  });
});

describe('GET /chats/:id/messages cursor validation and shape', () => {
  function rawGet(chatId: string, query: string) {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    authRestores.push(restore);
    return app.handle(new Request(`http://localhost/chats/${chatId}/messages?${query}`));
  }

  it('keeps paging from a bare numeric cursor issued before the upgrade', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, [
      { id: 'legacy-1', timestamp: TIED_TIMESTAMP },
      { id: 'legacy-2', timestamp: TIED_TIMESTAMP + 1 },
      { id: 'legacy-3', timestamp: TIED_TIMESTAMP + 2 },
    ]);

    const page = await fetchPage(chatId, String(TIED_TIMESTAMP), 2);

    expect(page.messages.map((message) => message.id)).toEqual(['legacy-2', 'legacy-3']);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a malformed cursor instead of restarting from the first page', async () => {
    const chatId = await newChat();

    const response = await rawGet(chatId, 'cursor=not-a-cursor');
    const body = (await response.json()) as { error: string; code: string };

    expect(`status ${response.status} code ${body.code}`).toBe('status 400 code VALIDATION');
    expect(body.error).toContain('"not-a-cursor"');
    expect(body.error).toContain('expected shape: <timestamp>:<rowid>');
  });

  it('pages across negative, fractional and very large timestamps POST /messages can store', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, [
      { id: 'odd-d', timestamp: 1e21 },
      { id: 'odd-b', timestamp: 1.5 },
      { id: 'odd-a', timestamp: -5 },
      { id: 'odd-c', timestamp: 1.5 },
    ]);

    expect(await readAll(chatId, 1)).toEqual(['odd-a', 'odd-b', 'odd-c', 'odd-d']);
  });

  it('does not expose the paging rowid on returned messages', async () => {
    const chatId = await newChat();
    await insertMessages(chatId, tiedRows('shape', 2));

    const page = await fetchPage(chatId);

    expect(Object.keys(page.messages[0] ?? {})).not.toContain('rowid');
  });

  it('keeps distinct-timestamp rows in timestamp order across pages', async () => {
    const chatId = await newChat();
    const offsets = [3, 1, 2, 5, 4];
    await insertMessages(
      chatId,
      offsets.map((offset) => ({ id: `distinct-${offset}`, timestamp: TIED_TIMESTAMP + offset }))
    );

    expect(await readAll(chatId, 2)).toEqual([
      'distinct-1',
      'distinct-2',
      'distinct-3',
      'distinct-4',
      'distinct-5',
    ]);
  });
});
