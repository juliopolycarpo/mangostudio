import { describe, expect, it } from 'bun:test';
import type { Chat } from '@mangostudio/shared/chat';
import { getDb } from '../../../../../src/db/database';
import {
  extractContextInfo,
  listChatsUseCase,
} from '../../../../../src/modules/chats/application/list-chats';
import { toPublicChat } from '../../../../../src/modules/chats/application/public-chat';
import {
  getById,
  listByUserId,
  listProviderStatesByIds,
} from '../../../../../src/modules/chats/infrastructure/chat-repository';
import { insertTestChat, insertTestUser } from '../../../../support/factories';

const BASE_TIME = 1_750_000_000_000;

const TOKENS = { estimatedInputTokens: 20_000, contextLimit: 100_000 };

/** A continuation envelope the way a provider turn persists it, with a long cursor. */
function envelope(cursor: string | null = 'c'.repeat(64)): string {
  return JSON.stringify({
    schemaVersion: 1,
    provider: 'openai-compatible',
    mode: cursor ? 'responses' : 'stateless-loop',
    modelName: 'gpt-5',
    systemPromptHash: 'hash-a',
    toolsetHash: 'hash-b',
    cursor,
    context: {
      estimatedInputTokens: TOKENS.estimatedInputTokens,
      providerReportedInputTokens: TOKENS.estimatedInputTokens,
      contextLimit: TOKENS.contextLimit,
      estimatedUsageRatio: 0.2,
    },
  });
}

function snapshot(): string {
  return JSON.stringify({
    ...TOKENS,
    estimatedUsageRatio: 0.2,
    mode: 'stateful',
    severity: 'normal',
    lastUpdatedAt: BASE_TIME,
  });
}

async function seedChat(
  userId: string,
  id: string,
  updatedAt: number,
  state: { lastContextState?: string | null; lastProviderState?: string | null }
) {
  await insertTestChat(userId, { id, title: id });
  await getDb()
    .updateTable('chats')
    .set({ updatedAt, ...state })
    .where('id', '=', id)
    .execute();
}

/** The list as it was before the projection: full rows, both state columns read. */
async function fullRowReference(userId: string): Promise<Chat[]> {
  const ids = await getDb()
    .selectFrom('chats')
    .select('id')
    .where('userId', '=', userId)
    .orderBy('updatedAt', 'desc')
    .execute();
  const chats: Chat[] = [];
  for (const { id } of ids) {
    const record = await getById(id, getDb());
    if (!record) throw new Error(`expected chat ${id} to exist | received: undefined`);
    chats.push(
      toPublicChat(record, extractContextInfo(record.lastContextState, record.lastProviderState))
    );
  }
  return chats;
}

describe('listChatsUseCase', () => {
  it('returns the same body as a full-row read for snapshot, null, legacy and unreadable-snapshot chats', async () => {
    const user = await insertTestUser();
    await seedChat(user.id, 'p-snapshot', BASE_TIME + 6, {
      lastContextState: snapshot(),
      lastProviderState: envelope('x'.repeat(64 * 1024)),
    });
    await seedChat(user.id, 'p-null', BASE_TIME + 5, {});
    await seedChat(user.id, 'p-legacy', BASE_TIME + 4, { lastProviderState: envelope() });
    await seedChat(user.id, 'p-legacy-replay', BASE_TIME + 3, {
      lastProviderState: envelope(null),
    });
    await seedChat(user.id, 'p-unreadable', BASE_TIME + 2, {
      lastContextState: '{not json',
      lastProviderState: envelope(),
    });
    await seedChat(user.id, 'p-unreadable-null', BASE_TIME + 1, { lastContextState: '{not json' });
    // Valid JSON from an older snapshot shape (no `lastUpdatedAt`) is unreadable too.
    await seedChat(user.id, 'p-stale-shape', BASE_TIME, {
      lastContextState: JSON.stringify({ ...JSON.parse(snapshot()), lastUpdatedAt: undefined }),
      lastProviderState: envelope(),
    });
    // An empty string and valid JSON that is not an object are unreadable, not absent.
    const notObjects = { 'p-empty-string': '', 'p-json-null': 'null', 'p-json-zero': '0' };
    let offset = 0;
    for (const [id, lastContextState] of Object.entries(notObjects)) {
      await seedChat(user.id, id, BASE_TIME - 1 - offset++, {
        lastContextState,
        lastProviderState: envelope(),
      });
    }

    const received = await listChatsUseCase(user.id, getDb());
    const expected = await fullRowReference(user.id);

    expect(received.map((chat) => chat.id)).toEqual([
      'p-snapshot',
      'p-null',
      'p-legacy',
      'p-legacy-replay',
      'p-unreadable',
      'p-unreadable-null',
      'p-stale-shape',
      'p-empty-string',
      'p-json-null',
      'p-json-zero',
    ]);
    const contexts = Object.fromEntries(received.map((chat) => [chat.id, chat.contextInfo?.mode]));
    expect(contexts).toEqual({
      'p-snapshot': 'stateful',
      'p-null': undefined,
      'p-legacy': 'stateful',
      'p-legacy-replay': 'replay',
      'p-unreadable': 'stateful',
      'p-unreadable-null': undefined,
      'p-stale-shape': 'stateful',
      'p-empty-string': 'stateful',
      'p-json-null': 'stateful',
      'p-json-zero': 'stateful',
    });
    expect(
      JSON.stringify(received),
      `expected list body to equal the full-row read | received: ${JSON.stringify(received)}`
    ).toBe(JSON.stringify(expected));
  });

  it('keeps the legacy context of a chat that has provider state and no snapshot', async () => {
    const user = await insertTestUser();
    await seedChat(user.id, 'legacy-only', BASE_TIME, { lastProviderState: envelope() });

    const [chat] = await listChatsUseCase(user.id, getDb());

    const received = chat?.contextInfo?.estimatedInputTokens;
    expect(received, `expected context tokens: 20000 | received: ${received}`).toBe(20_000);
    expect(chat?.contextInfo).toEqual({
      estimatedInputTokens: 20_000,
      contextLimit: 100_000,
      estimatedUsageRatio: 0.2,
      mode: 'stateful',
      severity: 'normal',
    });
  });

  it('resolves more unreadable snapshots than one provider-state batch holds', async () => {
    const user = await insertTestUser();
    const total = 501;
    for (let index = 0; index < total; index++) {
      await seedChat(user.id, `bulk-${index}`, BASE_TIME + index, {
        lastContextState: '{not json',
        lastProviderState: envelope(),
      });
    }

    const chats = await listChatsUseCase(user.id, getDb());

    const withContext = chats.filter((chat) => chat.contextInfo?.estimatedInputTokens === 20_000);
    expect(
      withContext.length,
      `expected chats with legacy context: ${total} | received: ${withContext.length}`
    ).toBe(total);
  });
});

describe('listByUserId', () => {
  it('leaves the continuation envelope out of every chat that has a context snapshot', async () => {
    const user = await insertTestUser();
    await seedChat(user.id, 'with-snapshot', BASE_TIME + 1, {
      lastContextState: snapshot(),
      lastProviderState: envelope(),
    });
    await seedChat(user.id, 'without-snapshot', BASE_TIME, { lastProviderState: envelope() });

    const rows = await listByUserId(user.id, getDb());

    const states = Object.fromEntries(rows.map((row) => [row.id, row.lastProviderState]));
    expect(states).toEqual({ 'with-snapshot': null, 'without-snapshot': envelope() });
  });
});

describe('listProviderStatesByIds', () => {
  it('returns envelopes for the owner only and omits chats without one', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    await seedChat(owner.id, 'mine', BASE_TIME, { lastProviderState: envelope() });
    await seedChat(owner.id, 'empty', BASE_TIME, {});
    await seedChat(other.id, 'theirs', BASE_TIME, { lastProviderState: envelope() });

    const states = await listProviderStatesByIds(
      owner.id,
      ['mine', 'empty', 'theirs', 'missing'],
      getDb()
    );

    expect([...states.keys()]).toEqual(['mine']);
    expect(states.get('mine')).toBe(envelope());
  });

  it('returns an empty map without querying when no ids are given', async () => {
    const owner = await insertTestUser();

    const states = await listProviderStatesByIds(owner.id, [], getDb());

    expect(states.size).toBe(0);
  });
});
