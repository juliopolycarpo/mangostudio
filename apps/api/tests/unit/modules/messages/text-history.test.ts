/**
 * `messages.interactionMode` outlived the chat/agent mode axis it was named
 * for: rows written before the axis was retired carry `chat`, streamed turns
 * carry `agent`, and both are the same text transcript. Matching on either
 * literal silently hands the model half a conversation, so the predicate is
 * pinned here rather than left to the query builder.
 */

import { describe, expect, it } from 'bun:test';
import type { InteractionMode } from '@mangostudio/shared/types';
import { getDb } from '../../../../src/db/database';
import {
  loadHistory,
  loadRichHistory,
} from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

let sequence = 0;

async function insertTurn(
  chatId: string,
  text: string,
  interactionMode: InteractionMode
): Promise<void> {
  sequence += 1;
  await getDb()
    .insertInto('messages')
    .values({
      id: `msg-${chatId}-${sequence}`,
      chatId,
      role: 'user',
      text,
      timestamp: Date.now() + sequence,
      isGenerating: 0,
      interactionMode,
    })
    .execute();
}

describe('text history loading', () => {
  it('includes both pre-retirement chat turns and streamed agent turns', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertTurn(chat.id, 'written before the mode axis went away', 'chat');
    await insertTurn(chat.id, 'written by a streamed turn', 'agent');

    const history = await loadHistory(chat.id, {}, getDb());

    expect(history.map((turn) => turn.text)).toEqual([
      'written before the mode axis went away',
      'written by a streamed turn',
    ]);
  });

  it('excludes image turns, which are a separate transcript', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertTurn(chat.id, 'text turn', 'agent');
    await insertTurn(chat.id, 'a picture of a mango', 'image');

    const history = await loadHistory(chat.id, {}, getDb());

    expect(history.map((turn) => turn.text)).toEqual(['text turn']);
  });

  it('applies the same predicate to the rich history the agent loop replays', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertTurn(chat.id, 'chat-mode turn', 'chat');
    await insertTurn(chat.id, 'agent-mode turn', 'agent');
    await insertTurn(chat.id, 'image turn', 'image');

    const history = await loadRichHistory(chat.id, {}, getDb());

    expect(history.map((turn) => turn.text)).toEqual(['chat-mode turn', 'agent-mode turn']);
  });
});

describe('text history ordering across rows sharing a timestamp', () => {
  const TIED_TIMESTAMP = 1_700_000_000_000;
  const ROW_COUNT = 12;
  const TIE_GROUP_SIZE = 3;

  /** Inserts m00..m11 in order; every three consecutive rows share one timestamp. */
  async function seedTiedChat(): Promise<string> {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({
      id: `tie-${chat.id}-m${String(index).padStart(2, '0')}`,
      chatId: chat.id,
      role: 'user' as const,
      text: `m${String(index).padStart(2, '0')}`,
      timestamp: TIED_TIMESTAMP + Math.floor(index / TIE_GROUP_SIZE),
      isGenerating: 0,
      interactionMode: 'agent' as const,
    }));
    await getDb().insertInto('messages').values(rows).execute();
    return chat.id;
  }

  function expectTexts(received: string[], expected: string[]) {
    if (received.join(' ') === expected.join(' ')) return;
    throw new Error(
      `expected history window: ${expected.join(' ')} | received: ${received.join(' ')}`
    );
  }

  // A limit of 5 splits the tie group m06..m08: the window must keep the
  // newest rows (m07, m08), not the oldest, and read in insertion order.
  const EXPECTED_WINDOW = ['m07', 'm08', 'm09', 'm10', 'm11'];

  it('keeps the newest tied rows when a limit splits a tie group', async () => {
    const chatId = await seedTiedChat();

    const history = await loadHistory(chatId, { limit: 5 }, getDb());

    expectTexts(
      history.map((turn) => turn.text),
      EXPECTED_WINDOW
    );
  });

  it('keeps the newest tied rows in the rich history the agent loop replays', async () => {
    const chatId = await seedTiedChat();

    const history = await loadRichHistory(chatId, { limit: 5 }, getDb());

    expectTexts(
      history.map((turn) => turn.text),
      EXPECTED_WINDOW
    );
  });
});
