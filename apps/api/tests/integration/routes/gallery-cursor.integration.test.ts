import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { messageRoutes } from '../../../src/modules/messages/http/message-routes';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TIED_TIMESTAMP = 1_700_000_000_000;
const PAGE_SIZE = 50;

interface PageBody {
  items: { id: string; messageId: string; imageUrl: string; createdAt: number }[];
  nextCursor: string | null;
}

let user!: UserFixture;
let chatId = '';
let tag = '';
let restoreAuth: (() => void) | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'] | null = null;

// The gallery is scoped to one user, so every test gets its own user and chat.
beforeEach(async () => {
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  tag = user.id.slice(-12);
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  app = null;
});

/** Row ids are global, so every id a test seeds carries this test's tag. */
function uid(name: string): string {
  return `${tag}-${name}`;
}

/** Ids count down while insertion order counts up, so rowid order and id order disagree. */
function descendingIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    uid(`${prefix}-${String(count - index).padStart(3, '0')}`)
  );
}

/** Legacy images: an `ai` message carrying `imageUrl`, with no `generated_images` row. */
async function insertLegacyImages(ids: string[], timestamp = TIED_TIMESTAMP) {
  if (ids.length === 0) return;
  await getDb()
    .insertInto('messages')
    .values(
      ids.map((id) => ({
        id,
        chatId,
        role: 'ai' as const,
        text: '',
        imageUrl: `/uploads/${id}.png`,
        timestamp,
        isGenerating: 0,
        interactionMode: 'image' as const,
      }))
    )
    .execute();
}

/** Artifact images: a `generated_images` row, one carrier `ai` message per image. */
async function insertArtifactImages(ids: string[], createdAt = TIED_TIMESTAMP) {
  if (ids.length === 0) return;
  const db = getDb();
  await db
    .insertInto('messages')
    .values(
      ids.map((id) => ({
        id: `carrier-${id}`,
        chatId,
        role: 'ai' as const,
        text: '',
        timestamp: createdAt,
        isGenerating: 0,
        interactionMode: 'image' as const,
      }))
    )
    .execute();
  await db
    .insertInto('generated_images')
    .values(
      ids.map((id) => ({
        id,
        userId: user.id,
        chatId,
        messageId: `carrier-${id}`,
        prompt: id,
        imageUrl: `/uploads/${id}.png`,
        createdAt,
        toolCallId: null,
        modelName: null,
        generationTime: null,
        metadataJson: null,
      }))
    )
    .execute();
}

/**
 * One authenticated app per test: each `createAuthenticatedApiTestApp` call
 * wraps the previous call's session mock, so restoring only the last one
 * would leave a stale session mock behind for later test files.
 */
function rawGet(query: string) {
  if (!app) {
    const created = createAuthenticatedApiTestApp(user, messageRoutes);
    app = created.app;
    restoreAuth = created.restore;
  }
  return app.handle(new Request(`http://localhost/messages/images?${query}`));
}

async function fetchPage(cursor?: string | null, limit = PAGE_SIZE) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const response = await rawGet(query.toString());
  if (response.status !== 200) {
    throw new Error(`expected status: 200 | received: ${response.status}`);
  }
  return (await response.json()) as PageBody;
}

async function readAll(limit = PAGE_SIZE): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  // Bounded so a cursor that never advances fails loudly instead of hanging.
  for (let guard = 0; guard < 200; guard++) {
    const page: PageBody = await fetchPage(cursor, limit);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error(`expected pages to end within 200 requests | received: a cursor that never ends`);
}

function expectSize(label: string, expected: number, received: number) {
  if (expected === received) return;
  throw new Error(`expected ${label}: ${expected} images | received: ${received}`);
}

describe('GET /messages/images tie-safe cursor', () => {
  it('returns every artifact image of a 65-image timestamp tie across two pages', async () => {
    await insertArtifactImages(descendingIds('art', 65));

    const first = await fetchPage();
    expectSize('first page', PAGE_SIZE, first.items.length);
    const second = await fetchPage(first.nextCursor);

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expectSize('combined gallery pages', 65, ids.length);
    expect(new Set(ids).size).toBe(65);
    expect(second.nextCursor).toBeNull();
  });

  it('returns every legacy image of a 65-image timestamp tie across two pages', async () => {
    await insertLegacyImages(descendingIds('legacy', 65));

    const first = await fetchPage();
    const second = await fetchPage(first.nextCursor);

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expectSize('combined gallery pages', 65, ids.length);
    expect(new Set(ids).size).toBe(65);
    expect(second.nextCursor).toBeNull();
  });

  it('returns a tie group spread over both sources exactly once across many pages', async () => {
    await insertArtifactImages(descendingIds('art', 33));
    await insertLegacyImages(descendingIds('legacy', 32));

    // 33 puts a page boundary exactly between the last artifact and the first message.
    for (const limit of [7, 33, 32, 1]) {
      const paged = await readAll(limit);

      expectSize(`combined gallery pages at limit ${limit}`, 65, paged.length);
      expect(new Set(paged).size).toBe(65);
    }
  });

  it('pages in the same order an unpaged read returns', async () => {
    await insertArtifactImages(descendingIds('art', 20));
    await insertLegacyImages(descendingIds('legacy', 20));
    await insertArtifactImages(descendingIds('newer', 5), TIED_TIMESTAMP + 1);
    await insertLegacyImages(descendingIds('older', 5), TIED_TIMESTAMP - 1);

    const unpaged = await fetchPage(null, 100);
    const paged = await readAll(6);

    expectSize('unpaged images', 50, unpaged.items.length);
    expect(paged).toEqual(unpaged.items.map((item) => item.id));
  });

  it('returns images inserted between pages exactly once', async () => {
    await insertArtifactImages(descendingIds('ins', 60));

    const first = await fetchPage();
    await insertArtifactImages(descendingIds('late', 5));
    const second = await fetchPage(first.nextCursor);

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith(uid('ins-')))).toHaveLength(60);
  });

  it('keeps distinct-timestamp images in newest-first order across pages', async () => {
    await insertArtifactImages([uid('d-1')], TIED_TIMESTAMP + 1);
    await insertLegacyImages([uid('d-2')], TIED_TIMESTAMP + 2);
    await insertArtifactImages([uid('d-3')], TIED_TIMESTAMP + 3);
    await insertLegacyImages([uid('d-4')], TIED_TIMESTAMP + 4);
    await insertArtifactImages([uid('d-5')], TIED_TIMESTAMP + 5);

    expect(await readAll(2)).toEqual(['d-5', 'd-4', 'd-3', 'd-2', 'd-1'].map(uid));
  });
});

describe('GET /messages/images cursor validation and shape', () => {
  it('keeps paging from a bare numeric cursor issued before the upgrade without repeats', async () => {
    await insertArtifactImages([uid('old-1')], TIED_TIMESTAMP - 2);
    await insertLegacyImages([uid('old-2')], TIED_TIMESTAMP - 1);
    await insertArtifactImages(descendingIds('tie', 3));

    const page = await fetchPage(String(TIED_TIMESTAMP));

    expect(page.items.map((item) => item.id)).toEqual([uid('old-2'), uid('old-1')]);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a malformed cursor instead of restarting from the first page', async () => {
    await insertArtifactImages([uid('any-1')]);

    const response = await rawGet('cursor=not-a-cursor');
    const body = (await response.json()) as { error: string; code: string };

    expect(`status ${response.status} code ${body.code}`).toBe('status 400 code VALIDATION');
    expect(body.error).toContain('"not-a-cursor"');
    expect(body.error).toContain('expected shape');
  });

  it('does not expose paging internals on returned items', async () => {
    await insertArtifactImages(descendingIds('shape', 2));
    await insertLegacyImages(descendingIds('shape-legacy', 2));

    const page = await fetchPage();

    const keys = new Set(page.items.flatMap((item) => Object.keys(item)));
    expect([...keys].filter((key) => /rowid|source/i.test(key))).toEqual([]);
  });
});
