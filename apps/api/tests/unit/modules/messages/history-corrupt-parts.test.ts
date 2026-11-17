/**
 * Model history keeps a message whose `parts` cell is damaged, as plain text.
 * Skipping it would drop a turn and break the user/assistant alternation the
 * providers expect; its `text` column is the same copy `loadHistory` sends.
 */

import { describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import {
  loadHistory,
  loadRichHistory,
} from '../../../../src/modules/messages/infrastructure/message-repository';
import { buildOpenAIResponsesReplay } from '../../../../src/services/providers/core/replay-builder';
import { DiagnosticWarnCapture } from '../../../support/diagnostic-warn-capture';
import { insertTestChat, insertTestUser } from '../../../support/factories';

let sequence = 0;

async function insertTurn(chatId: string, id: string, role: 'user' | 'ai', parts: string | null) {
  sequence += 1;
  await getDb()
    .insertInto('messages')
    .values({
      id,
      chatId,
      role,
      text: `text of ${id}`,
      timestamp: Date.now() + sequence,
      isGenerating: 0,
      interactionMode: 'agent',
      parts,
    })
    .execute();
}

async function seedChat() {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const validParts = JSON.stringify([{ type: 'text', text: 'valid' }]);
  await insertTurn(chat.id, `a-${chat.id}`, 'user', validParts);
  await insertTurn(chat.id, `b-${chat.id}`, 'ai', '{not json');
  await insertTurn(chat.id, `c-${chat.id}`, 'user', validParts);
  return chat.id;
}

describe('history with one corrupt parts cell', () => {
  it('keeps the corrupt turn as text in rich history, in order', async () => {
    const chatId = await seedChat();

    const history = await loadRichHistory(chatId, {}, getDb());

    expect(history.map((turn) => turn.id)).toEqual([`a-${chatId}`, `b-${chatId}`, `c-${chatId}`]);
    expect(history[0]?.parts).toEqual([{ type: 'text', text: 'valid' }]);
    expect(history[1]?.parts).toBeUndefined();
    expect(history[1]?.text).toBe(`text of b-${chatId}`);
    expect(history[2]?.parts).toEqual([{ type: 'text', text: 'valid' }]);
  });

  it('keeps the corrupt turn in simple history, in order', async () => {
    const chatId = await seedChat();

    const history = await loadHistory(chatId, {}, getDb());

    expect(history.map((turn) => turn.text)).toEqual([
      `text of a-${chatId}`,
      `text of b-${chatId}`,
      `text of c-${chatId}`,
    ]);
  });

  it('leaves no tool call or tool result behind when the corrupt turn held tool calls', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertTurn(chat.id, `u1-${chat.id}`, 'user', null);
    // Tool calls and their results live in one assistant turn's parts, so damage to that
    // cell removes both sides of every pair; nothing can be left unpaired in the next turn.
    await insertTurn(chat.id, `a1-${chat.id}`, 'ai', '[{"type":"tool_call","toolCallId":"c1"');
    await insertTurn(chat.id, `u2-${chat.id}`, 'user', null);

    const history = await loadRichHistory(chat.id, {}, getDb());
    const items = buildOpenAIResponsesReplay(history);

    const toolItems = items.filter((item) => 'type' in item);
    expect(toolItems).toEqual([]);
    expect(items.map((item) => item.role)).toEqual(['user', 'assistant', 'user']);
  });
});

/**
 * The corrupt-parts warning comes from the read that uses a row's parts. Text
 * history sends `text` only and does not even select most `parts` cells, so it
 * reports nothing; rich history replays the parts and reports the cell.
 */
describe('corrupt parts warning on history reads', () => {
  function warningsFor(lines: readonly string[], messageId: string): string[] {
    return lines.filter(
      (line) => line.includes('corrupt_message_parts') && line.includes(messageId)
    );
  }

  it.each([
    ['without a boundary event name', '{not json'],
    ['naming a boundary event', '[{"type":"system_event","event":"chat_compacted"'],
  ])('text history stays silent for a corrupt cell %s', async (_label, corruptParts) => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const corruptId = `text-silent-${chat.id}`;
    await insertTurn(chat.id, `u-${chat.id}`, 'user', null);
    await insertTurn(chat.id, corruptId, 'ai', corruptParts);

    let history: Awaited<ReturnType<typeof loadHistory>> = [];
    const lines = await new DiagnosticWarnCapture().during(async () => {
      history = await loadHistory(chat.id, {}, getDb());
    });

    expect(history.map((turn) => turn.id)).toEqual([`u-${chat.id}`, corruptId]);
    expect(warningsFor(lines, corruptId)).toEqual([]);
  });

  it('rich history reports the corrupt cell once by message id', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const corruptId = `rich-warns-${chat.id}`;
    await insertTurn(chat.id, `u-${chat.id}`, 'user', null);
    await insertTurn(chat.id, corruptId, 'ai', '{not json');

    const lines = await new DiagnosticWarnCapture().during(() =>
      loadRichHistory(chat.id, {}, getDb())
    );

    const warnings = warningsFor(lines, corruptId);
    if (warnings.length !== 1) {
      throw new Error(
        `expected corrupt_message_parts warnings for ${corruptId}: 1 | received: ${JSON.stringify(lines)}`
      );
    }
  });
});
