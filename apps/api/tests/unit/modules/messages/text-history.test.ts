/**
 * `messages.interactionMode` outlived the chat/agent mode axis it was named
 * for: rows written before the axis was retired carry `chat`, streamed turns
 * carry `agent`, and both are the same text transcript. Matching on either
 * literal silently hands the model half a conversation, so the predicate is
 * pinned here rather than left to the query builder.
 */

import { describe, expect, it } from 'bun:test';

import type { InteractionMode } from '@mangostudio/shared/types';
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';

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

/** Named fake: records every row SQLite hands back to Kysely, before any mapping. */
class SelectedRowsCapture implements KyselyPlugin {
  readonly rows: Record<string, unknown>[] = [];

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    this.rows.push(...args.result.rows);
    return Promise.resolve(args.result);
  }
}

describe('text history compaction boundary', () => {
  const BIG_TOOL_RESULT = 'r'.repeat(20_000);
  const TOOL_RESULT_PARTS = JSON.stringify([
    { type: 'tool_result', toolCallId: 'c1', content: BIG_TOOL_RESULT },
  ]);
  const COMPACTED_PARTS = JSON.stringify([{ type: 'system_event', event: 'chat_compacted' }]);
  const HANDOFF_PARTS = JSON.stringify([{ type: 'system_event', event: 'summary_handoff' }]);
  // Names a boundary event in prose without being a boundary.
  const PROSE_MENTION_PARTS = JSON.stringify([
    { type: 'text', text: 'the summary_handoff and chat_compacted events, quoted' },
    { type: 'system_event', event: 'tool_notice' },
  ]);

  /** Inserts one agent turn per entry, in order, and returns their ids. */
  async function seedTurns(
    turns: readonly { text: string; parts: string | null }[]
  ): Promise<{ chatId: string; ids: string[] }> {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const ids: string[] = [];
    for (const turn of turns) {
      sequence += 1;
      const id = `boundary-${chat.id}-${sequence}`;
      ids.push(id);
      await getDb()
        .insertInto('messages')
        .values({
          id,
          chatId: chat.id,
          role: 'ai',
          text: turn.text,
          timestamp: Date.now() + sequence,
          isGenerating: 0,
          interactionMode: 'agent',
          parts: turn.parts,
        })
        .execute();
    }
    return { chatId: chat.id, ids };
  }

  it('copies parts out of SQLite only for rows that name a boundary event', async () => {
    const { chatId } = await seedTurns([
      { text: 'tool turn', parts: TOOL_RESULT_PARTS },
      { text: 'boundary', parts: COMPACTED_PARTS },
      { text: 'after', parts: TOOL_RESULT_PARTS },
      { text: 'prose', parts: PROSE_MENTION_PARTS },
      { text: 'plain', parts: null },
    ]);
    const capture = new SelectedRowsCapture();

    await loadHistory(chatId, {}, getDb().withPlugin(capture));

    const received = capture.rows.map((row) => row.parts);
    // Newest first, as SQLite returns them: plain, prose, after, boundary, tool turn.
    const expected = [null, PROSE_MENTION_PARTS, null, COMPACTED_PARTS, null];
    if (JSON.stringify(received) !== JSON.stringify(expected)) {
      throw new Error(
        `expected selected parts lengths: [null,${PROSE_MENTION_PARTS.length},null,${COMPACTED_PARTS.length},null] | received lengths: ${JSON.stringify(
          received.map((parts) => (typeof parts === 'string' ? parts.length : parts))
        )}`
      );
    }
  });

  // Rich history decodes every row's parts, so it is the reference for where
  // the text history must start.
  it.each([
    [
      'a compaction boundary',
      [
        { text: 'before', parts: TOOL_RESULT_PARTS },
        { text: 'boundary', parts: COMPACTED_PARTS },
        { text: 'after', parts: TOOL_RESULT_PARTS },
      ],
    ],
    [
      'a summary handoff boundary',
      [
        { text: 'old', parts: null },
        { text: 'handoff', parts: HANDOFF_PARTS },
      ],
    ],
    [
      'a row that names the events in prose only',
      [
        { text: 'earlier', parts: TOOL_RESULT_PARTS },
        { text: 'prose', parts: PROSE_MENTION_PARTS },
      ],
    ],
    [
      'a corrupt cell that names an event',
      [
        { text: 'earlier', parts: null },
        { text: 'corrupt', parts: '[{"type":"system_event","event":"chat_compacted"' },
        { text: 'later', parts: TOOL_RESULT_PARTS },
      ],
    ],
    [
      'a corrupt cell before a boundary',
      [
        { text: 'corrupt', parts: '{not json' },
        { text: 'boundary', parts: HANDOFF_PARTS },
        { text: 'after', parts: null },
      ],
    ],
    [
      'no parts at all',
      [
        { text: 'one', parts: null },
        { text: 'two', parts: null },
      ],
    ],
  ])('starts where the rich history starts with %s', async (_label, turns) => {
    const { chatId } = await seedTurns(turns);

    const history = await loadHistory(chatId, {}, getDb());
    const rich = await loadRichHistory(chatId, {}, getDb());

    expect(history.map((turn) => turn.id)).toEqual(rich.map((turn) => turn.id));
    expect(history.map((turn) => turn.text)).toEqual(rich.map((turn) => turn.text));
  });

  it('starts where the rich history starts under a limit and excluded ids', async () => {
    const { chatId, ids } = await seedTurns([
      { text: 'first boundary', parts: COMPACTED_PARTS },
      { text: 'middle', parts: TOOL_RESULT_PARTS },
      { text: 'second boundary', parts: HANDOFF_PARTS },
      { text: 'after', parts: TOOL_RESULT_PARTS },
      { text: 'newest', parts: null },
    ]);
    const options = { limit: 4, excludeIds: [ids[2] as string] };

    const history = await loadHistory(chatId, options, getDb());
    const rich = await loadRichHistory(chatId, options, getDb());

    expect(history.map((turn) => turn.text)).toEqual([
      'first boundary',
      'middle',
      'after',
      'newest',
    ]);
    expect(history.map((turn) => turn.id)).toEqual(rich.map((turn) => turn.id));
  });
});
