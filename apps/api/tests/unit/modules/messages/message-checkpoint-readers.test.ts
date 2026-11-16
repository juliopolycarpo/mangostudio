/**
 * A generating turn's stored columns are its last full rewrite; what it
 * checkpointed since sits in `message_checkpoint_deltas`. Every other reader of
 * `messages` has to see the folded state, and a write that settles or edits the
 * row has to fold before it clears the deltas.
 */
import { describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import { insertCheckpointDelta } from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';
import {
  insertMessage,
  listByChatId,
  loadHistory,
  loadRichHistory,
  updateMessage,
} from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const FIRST_CHECKPOINT = 'The answer begins';
const LATER_TEXT = ' and keeps going';
const FOLDED = `${FIRST_CHECKPOINT}${LATER_TEXT}`;

/** A chat with a user message and a generating reply holding its first checkpoint plus one delta. */
async function chatWithGeneratingReply() {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const base = Date.now();
  await insertMessage(
    {
      id: crypto.randomUUID(),
      chatId: chat.id,
      role: 'user',
      text: 'Tell me more',
      timestamp: base,
      isGenerating: false,
      interactionMode: 'agent',
    },
    getDb()
  );
  const replyId = crypto.randomUUID();
  await insertMessage(
    {
      id: replyId,
      chatId: chat.id,
      role: 'ai',
      text: FIRST_CHECKPOINT,
      timestamp: base + 1,
      isGenerating: true,
      interactionMode: 'agent',
      parts: JSON.stringify([{ type: 'text', text: FIRST_CHECKPOINT }]),
      providerState: 'state-at-first-checkpoint',
    },
    getDb()
  );
  await insertCheckpointDelta(
    {
      messageId: replyId,
      seq: 1,
      deltaJson: JSON.stringify({
        text: LATER_TEXT,
        ops: [{ i: 0, append: LATER_TEXT }],
        providerState: 'state-at-last-checkpoint',
      }),
    },
    getDb()
  );
  return { chat, replyId };
}

const storedRow = (id: string) =>
  getDb()
    .selectFrom('messages')
    .select(['text', 'parts', 'providerState', 'isGenerating'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

const deltaRows = async (id: string): Promise<number> =>
  (
    await getDb()
      .selectFrom('message_checkpoint_deltas')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('messageId', '=', id)
      .executeTakeFirstOrThrow()
  ).count;

describe('history readers on a generating turn', () => {
  it('loadHistory returns the turn as its last checkpoint left it', async () => {
    const { chat, replyId } = await chatWithGeneratingReply();

    const history = await loadHistory(chat.id, {}, getDb());

    expect(history.find((turn) => turn.id === replyId)?.text).toBe(FOLDED);
  });

  it('loadRichHistory returns the folded text, parts and provider state', async () => {
    const { chat, replyId } = await chatWithGeneratingReply();

    const history = await loadRichHistory(chat.id, {}, getDb());

    const reply = history.find((turn) => turn.id === replyId);
    expect(reply).toMatchObject({
      text: FOLDED,
      parts: [{ type: 'text', text: FOLDED }],
      providerState: 'state-at-last-checkpoint',
    });
  });

  it('agree with the transcript page, which folds the same row', async () => {
    const { chat, replyId } = await chatWithGeneratingReply();

    const page = await listByChatId(chat.id, {}, getDb());
    const [history, rich] = await Promise.all([
      loadHistory(chat.id, {}, getDb()),
      loadRichHistory(chat.id, {}, getDb()),
    ]);

    const text = (turns: ReadonlyArray<{ id: string; text: string }>) =>
      turns.find((turn) => turn.id === replyId)?.text;
    expect([text(history), text(rich)]).toEqual([text(page.messages), text(page.messages)]);
  });

  it('keeps a settled turn as stored', async () => {
    const { chat, replyId } = await chatWithGeneratingReply();
    await getDb()
      .updateTable('messages')
      .set({ isGenerating: 0, text: 'final text' })
      .where('id', '=', replyId)
      .execute();

    const history = await loadHistory(chat.id, {}, getDb());

    expect(history.find((turn) => turn.id === replyId)?.text).toBe('final text');
  });
});

describe('updateMessage on a generating turn', () => {
  it('keeps the checkpointed content when the patch clears isGenerating', async () => {
    const { replyId } = await chatWithGeneratingReply();

    await updateMessage(replyId, { isGenerating: false }, getDb());

    const row = await storedRow(replyId);
    expect({
      text: row.text,
      parts: JSON.parse(row.parts ?? '[]'),
      providerState: row.providerState,
      isGenerating: row.isGenerating,
      deltas: await deltaRows(replyId),
    }).toEqual({
      text: FOLDED,
      parts: [{ type: 'text', text: FOLDED }],
      providerState: 'state-at-last-checkpoint',
      isGenerating: 0,
      deltas: 0,
    });
  });

  it('applies a text patch over the folded row and drops the deltas it would be appended to', async () => {
    const { replyId } = await chatWithGeneratingReply();

    await updateMessage(replyId, { text: 'edited by hand' }, getDb());

    const row = await storedRow(replyId);
    expect({
      text: row.text,
      parts: JSON.parse(row.parts ?? '[]'),
      isGenerating: row.isGenerating,
      deltas: await deltaRows(replyId),
    }).toEqual({
      text: 'edited by hand',
      // The patch only names `text`; parts keep what the turn had checkpointed.
      parts: [{ type: 'text', text: FOLDED }],
      isGenerating: 1,
      deltas: 0,
    });
  });

  it('writes a patch to a settled message as before', async () => {
    const { replyId } = await chatWithGeneratingReply();
    await updateMessage(replyId, { isGenerating: false }, getDb());

    await updateMessage(replyId, { text: 'later edit' }, getDb());

    expect((await storedRow(replyId)).text).toBe('later edit');
  });

  it('leaves the deltas alone when the patch touches no checkpointed column', async () => {
    const { replyId } = await chatWithGeneratingReply();

    await updateMessage(replyId, { modelName: 'gpt-test' }, getDb());

    expect(await deltaRows(replyId)).toBe(1);
  });
});
