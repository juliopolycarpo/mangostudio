/**
 * A streaming turn writes its checkpoints as deltas over the `messages` row.
 * Everything that can see a generating row must read it as its last checkpoint
 * left it, and no delta may outlive the turn that wrote it.
 */
import { describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../../src/db/database';
import { finalizeCheckpointedAiResponse } from '../../../../src/modules/generation/infrastructure/conversation-persistence';
import {
  type CheckpointDelta,
  type CheckpointedContent,
  foldCheckpointDeltas,
  foldCheckpointDeltasIntoRows,
  insertCheckpointDelta,
  rewriteCheckpointedRow,
} from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';
import {
  insertMessage,
  listByChatId,
} from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const EMPTY: CheckpointedContent = {
  text: '',
  parts: [],
  providerState: null,
  generationTime: null,
};

describe('foldCheckpointDeltas', () => {
  it('appends text to the message and to the part an op names', () => {
    const base: CheckpointedContent = {
      ...EMPTY,
      text: 'he',
      parts: [{ type: 'text', text: 'he' }],
    };
    const folded = foldCheckpointDeltas(base, [
      { text: 'llo', ops: [{ i: 0, append: 'llo' }] },
      { text: '!', ops: [{ i: 0, append: '!' }] },
    ]);

    expect(folded.text).toBe('hello!');
    expect(folded.parts).toEqual([{ type: 'text', text: 'hello!' }]);
    // The base is a snapshot the caller keeps.
    expect(base.parts).toEqual([{ type: 'text', text: 'he' }]);
  });

  it('writes a part at its index and extends a thinking part', () => {
    const toolCall: MessagePart = { type: 'tool_call', toolCallId: 'c1', name: 'grep', args: {} };
    const folded = foldCheckpointDeltas({ ...EMPTY, parts: [{ type: 'thinking', text: 'a' }] }, [
      {
        ops: [
          { i: 0, append: 'b' },
          { i: 1, part: toolCall },
        ],
      },
      { ops: [{ i: 2, part: { type: 'tool_result', toolCallId: 'c1', content: 'out' } }] },
    ]);

    expect(folded.parts).toEqual([
      { type: 'thinking', text: 'ab' },
      toolCall,
      { type: 'tool_result', toolCallId: 'c1', content: 'out' },
    ]);
  });

  it('moves provider state and generation time only when the delta names them', () => {
    const base = { ...EMPTY, providerState: 'p1', generationTime: '1s' };

    expect(foldCheckpointDeltas(base, [{ text: 'x' }])).toMatchObject({
      providerState: 'p1',
      generationTime: '1s',
    });
    expect(
      foldCheckpointDeltas(base, [{ providerState: null, generationTime: '2s' }])
    ).toMatchObject({ providerState: null, generationTime: '2s' });
  });

  it('skips an append aimed at a part that cannot grow', () => {
    const toolCall: MessagePart = { type: 'tool_call', toolCallId: 'c1', name: 'grep', args: {} };
    const folded = foldCheckpointDeltas({ ...EMPTY, parts: [toolCall] }, [
      { ops: [{ i: 0, append: 'x' }] },
    ]);

    expect(folded.parts).toEqual([toolCall]);
  });
});

async function generatingMessage(partsJson = '[]') {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const id = crypto.randomUUID();
  await insertMessage(
    {
      id,
      chatId: chat.id,
      role: 'ai',
      text: '',
      timestamp: Date.now(),
      isGenerating: true,
      interactionMode: 'agent',
      parts: partsJson,
    },
    getDb()
  );
  return { id, chat, user };
}

const deltaCount = async (messageId: string): Promise<number> => {
  const row = await getDb()
    .selectFrom('message_checkpoint_deltas')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('messageId', '=', messageId)
    .executeTakeFirstOrThrow();
  return row.count;
};

const delta = (value: CheckpointDelta): string => JSON.stringify(value);

describe('foldCheckpointDeltasIntoRows', () => {
  it('returns the checkpointed state of a generating row, and leaves other rows alone', async () => {
    const { id } = await generatingMessage(JSON.stringify([{ type: 'text', text: 'he' }]));
    await insertCheckpointDelta(
      { messageId: id, seq: 0, deltaJson: delta({ text: 'llo', ops: [{ i: 0, append: 'llo' }] }) },
      getDb()
    );
    const stored = await getDb()
      .selectFrom('messages')
      .select(['id', 'text', 'parts', 'providerState', 'generationTime', 'isGenerating'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const finished = { ...stored, id: 'finished', isGenerating: 0 };

    const [live, done] = await foldCheckpointDeltasIntoRows([stored, finished], getDb());

    expect(live?.text).toBe('llo');
    expect(JSON.parse(live?.parts ?? '[]')).toEqual([{ type: 'text', text: 'hello' }]);
    expect(done).toBe(finished);
  });

  it('stops at a delta that does not parse instead of inventing a state past the gap', async () => {
    const { id } = await generatingMessage(JSON.stringify([{ type: 'text', text: '' }]));
    const insert = (seq: number, deltaJson: string) =>
      insertCheckpointDelta({ messageId: id, seq, deltaJson }, getDb());
    await insert(0, delta({ text: 'a', ops: [{ i: 0, append: 'a' }] }));
    await insert(1, '{not json');
    await insert(2, delta({ text: 'c', ops: [{ i: 0, append: 'c' }] }));
    const stored = await getDb()
      .selectFrom('messages')
      .select(['id', 'text', 'parts', 'providerState', 'isGenerating'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const [row] = await foldCheckpointDeltasIntoRows([stored], getDb());

    expect(row?.text).toBe('a');
  });
});

describe('listByChatId on a generating turn', () => {
  it('reads the last checkpoint, as a mid-stream reload would', async () => {
    const { id, chat } = await generatingMessage(JSON.stringify([{ type: 'text', text: 'ab' }]));
    await rewriteCheckpointedRow(
      {
        messageId: id,
        text: 'ab',
        partsJson: JSON.stringify([{ type: 'text', text: 'ab' }]),
        providerState: null,
        generationTime: undefined,
      },
      getDb()
    );
    await insertCheckpointDelta(
      { messageId: id, seq: 0, deltaJson: delta({ text: 'cd', ops: [{ i: 0, append: 'cd' }] }) },
      getDb()
    );

    const { messages } = await listByChatId(chat.id, {}, getDb());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id, text: 'abcd', isGenerating: true });
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'abcd' }]);
  });
});

describe('listByChatId racing a checkpoint rewrite', () => {
  it('never folds the old deltas onto the new row', async () => {
    const { id, chat } = await generatingMessage(JSON.stringify([{ type: 'text', text: 'ab' }]));
    await getDb().updateTable('messages').set({ text: 'ab' }).where('id', '=', id).execute();
    await insertCheckpointDelta(
      { messageId: id, seq: 1, deltaJson: delta({ text: 'cd', ops: [{ i: 0, append: 'cd' }] }) },
      getDb()
    );

    // The writer's rebase replaces the row and clears the deltas in one transaction.
    const [page] = await Promise.all([
      listByChatId(chat.id, {}, getDb()),
      rewriteCheckpointedRow(
        {
          messageId: id,
          text: 'zz',
          partsJson: JSON.stringify([{ type: 'text', text: 'zz' }]),
          providerState: null,
          generationTime: undefined,
        },
        getDb()
      ),
    ]);

    // Either whole state is fine; 'zzcd' would be old deltas over the new row.
    expect(['abcd', 'zz']).toContain(page.messages[0]?.text);
  });
});

describe('checkpoint delta lifetime', () => {
  it('writes no delta for a message that is no longer generating', async () => {
    const { id } = await generatingMessage();
    await getDb().updateTable('messages').set({ isGenerating: 0 }).where('id', '=', id).execute();

    const written = await insertCheckpointDelta(
      { messageId: id, seq: 0, deltaJson: delta({ text: 'late' }) },
      getDb()
    );

    expect({ written, rows: await deltaCount(id) }).toEqual({ written: false, rows: 0 });
  });

  it('drops the deltas when a rewrite replaces the row they were written over', async () => {
    const { id } = await generatingMessage();
    for (const seq of [0, 1, 2]) {
      await insertCheckpointDelta({ messageId: id, seq, deltaJson: delta({ text: 'x' }) }, getDb());
    }

    await rewriteCheckpointedRow(
      {
        messageId: id,
        text: 'xxx',
        partsJson: '[]',
        providerState: null,
        generationTime: undefined,
      },
      getDb()
    );

    expect(await deltaCount(id)).toBe(0);
  });

  it('drops the deltas when finalizeCheckpointedAiResponse ends the turn', async () => {
    const { id, chat, user } = await generatingMessage();
    await insertCheckpointDelta(
      { messageId: id, seq: 0, deltaJson: delta({ text: 'x' }) },
      getDb()
    );

    const finalized = await finalizeCheckpointedAiResponse(
      {
        id,
        userId: user.id,
        chatId: chat.id,
        text: 'final',
        parts: [{ type: 'text', text: 'final' }],
        generationTime: '1s',
        modelName: 'gpt-test',
      },
      getDb()
    );

    expect({ finalized, rows: await deltaCount(id) }).toEqual({ finalized: true, rows: 0 });
  });

  it('drops the deltas whichever statement clears isGenerating', async () => {
    const { id } = await generatingMessage();
    await insertCheckpointDelta(
      { messageId: id, seq: 0, deltaJson: delta({ text: 'x' }) },
      getDb()
    );

    await getDb().updateTable('messages').set({ text: 'edited' }).where('id', '=', id).execute();
    expect(await deltaCount(id)).toBe(1);
    await getDb().updateTable('messages').set({ isGenerating: 0 }).where('id', '=', id).execute();

    expect(await deltaCount(id)).toBe(0);
  });

  it('drops the deltas with the message', async () => {
    const { id } = await generatingMessage();
    await insertCheckpointDelta(
      { messageId: id, seq: 0, deltaJson: delta({ text: 'x' }) },
      getDb()
    );

    await getDb().deleteFrom('messages').where('id', '=', id).execute();

    expect(await deltaCount(id)).toBe(0);
  });
});
