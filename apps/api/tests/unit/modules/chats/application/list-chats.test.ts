import { describe, expect, it } from 'bun:test';
import type { ContextInfo } from '@mangostudio/shared/chat';
import { getDb } from '../../../../../src/db/database';
import { listChatsUseCase } from '../../../../../src/modules/chats/application/list-chats';
import { insertTestChat, insertTestUser } from '../../../../support/factories';

/**
 * Characterization of the chat list's derived `contextInfo`.
 *
 * Two stored columns feed it: `lastContextState` (the persisted snapshot) and
 * `lastProviderState` (the continuation envelope, which can be very large).
 * A readable snapshot wins; anything else falls back to the envelope. These
 * tests walk every combination of the two so a change to how the list reads
 * either column cannot silently drop a chat's context. Expectations are spelled
 * out per state, never derived through the code under test.
 */

const BASE_TIME = 1_750_000_000_000;

const ENVELOPE_CONTEXT = {
  estimatedInputTokens: 20_000,
  providerReportedInputTokens: 20_000,
  contextLimit: 100_000,
  estimatedUsageRatio: 0.2,
};

/** A continuation envelope the way a provider turn persists it. */
function envelope(cursor: string | null): string {
  return JSON.stringify({
    schemaVersion: 1,
    provider: 'openai-compatible',
    mode: cursor ? 'responses' : 'stateless-loop',
    modelName: 'gpt-5',
    systemPromptHash: 'hash-a',
    toolsetHash: 'hash-b',
    cursor,
    context: ENVELOPE_CONTEXT,
  });
}

/** Deliberately unlike the envelope's context so the winning source is visible. */
const SNAPSHOT = {
  estimatedInputTokens: 120_000,
  contextLimit: 200_000,
  estimatedUsageRatio: 0.6,
  mode: 'stateful',
  severity: 'warning',
  lastUpdatedAt: BASE_TIME,
};

const SNAPSHOT_INFO: ContextInfo = {
  estimatedInputTokens: 120_000,
  contextLimit: 200_000,
  estimatedUsageRatio: 0.6,
  mode: 'stateful',
  severity: 'warning',
};

const ENVELOPE_INFO_STATEFUL: ContextInfo = {
  estimatedInputTokens: 20_000,
  contextLimit: 100_000,
  estimatedUsageRatio: 0.2,
  mode: 'stateful',
  severity: 'normal',
};

const ENVELOPE_INFO_REPLAY: ContextInfo = { ...ENVELOPE_INFO_STATEFUL, mode: 'replay' };

/** Every state `lastContextState` can be in, and whether it is a readable snapshot. */
const CONTEXT_STATES: Record<string, { stored: string | null; readable: boolean }> = {
  null: { stored: null, readable: false },
  snapshot: { stored: JSON.stringify(SNAPSHOT), readable: true },
  'invalid-json': { stored: '{not json', readable: false },
  // Valid JSON from an older snapshot shape: no `lastUpdatedAt`.
  'older-shape': {
    stored: JSON.stringify({ ...SNAPSHOT, lastUpdatedAt: undefined }),
    readable: false,
  },
  'empty-string': { stored: '', readable: false },
  'json-null': { stored: 'null', readable: false },
  'json-zero': { stored: '0', readable: false },
};

/** Every state `lastProviderState` can be in, with what the envelope alone yields. */
const PROVIDER_STATES: Record<string, { stored: string | null; fallback: ContextInfo | null }> = {
  null: { stored: null, fallback: null },
  valid: { stored: envelope('resp_123'), fallback: ENVELOPE_INFO_STATEFUL },
  legacy: { stored: envelope(null), fallback: ENVELOPE_INFO_REPLAY },
  'large-cursor': { stored: envelope('x'.repeat(64 * 1024)), fallback: ENVELOPE_INFO_STATEFUL },
};

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

describe('listChatsUseCase context info', () => {
  it('derives contextInfo for every combination of stored context and provider state', async () => {
    const user = await insertTestUser();
    const expected: Record<string, ContextInfo | null> = {};
    let offset = 0;
    for (const [contextName, context] of Object.entries(CONTEXT_STATES)) {
      for (const [providerName, provider] of Object.entries(PROVIDER_STATES)) {
        const id = `ctx-${contextName}__provider-${providerName}`;
        await seedChat(user.id, id, BASE_TIME + offset++, {
          lastContextState: context.stored,
          lastProviderState: provider.stored,
        });
        expected[id] = context.readable ? SNAPSHOT_INFO : provider.fallback;
      }
    }

    const chats = await listChatsUseCase(user.id, getDb());

    expect(chats.length, `expected chats: ${offset} | received: ${chats.length}`).toBe(offset);
    for (const chat of chats) {
      const received = chat.contextInfo;
      expect(
        received,
        `expected contextInfo for ${chat.id}: ${JSON.stringify(expected[chat.id])} | received: ${JSON.stringify(received)}`
      ).toEqual(expected[chat.id]);
    }
  });

  it('keeps the legacy context of a chat that has provider state and no snapshot', async () => {
    const user = await insertTestUser();
    await seedChat(user.id, 'legacy-only', BASE_TIME, {
      lastProviderState: envelope('c'.repeat(64)),
    });

    const [chat] = await listChatsUseCase(user.id, getDb());

    const received = chat?.contextInfo?.estimatedInputTokens;
    expect(received, `expected context tokens: 20000 | received: ${received}`).toBe(20_000);
    expect(chat?.contextInfo).toEqual(ENVELOPE_INFO_STATEFUL);
  });

  it('omits contextInfo for a chat with neither stored state', async () => {
    const user = await insertTestUser();
    await seedChat(user.id, 'no-state', BASE_TIME, {});

    const [chat] = await listChatsUseCase(user.id, getDb());

    const received = chat?.contextInfo;
    expect(
      received,
      `expected contextInfo: null | received: ${JSON.stringify(received)}`
    ).toBeNull();
  });
});
