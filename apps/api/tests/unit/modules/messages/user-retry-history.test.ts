import { describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../../src/db/database';
import { loadRichHistory } from '../../../../src/modules/messages/infrastructure/message-repository';
import {
  annotateUserRetriedToolResults,
  USER_RETRY_NOTE,
} from '../../../../src/modules/messages/infrastructure/user-retry-annotation';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const MODEL_CALL: MessagePart = {
  type: 'tool_call',
  toolCallId: 'call-model',
  name: 'read_file',
  args: { path: 'a.txt' },
};
const MODEL_RESULT: MessagePart = {
  type: 'tool_result',
  toolCallId: 'call-model',
  content: 'timed out',
  isError: true,
};
const USER_CALL: MessagePart = {
  type: 'tool_call',
  toolCallId: 'call-user',
  name: 'read_file',
  args: { path: 'a.txt' },
  retryOf: 'call-model',
  initiatedBy: 'user',
};
const USER_RESULT: MessagePart = {
  type: 'tool_result',
  toolCallId: 'call-user',
  content: 'file body',
};

describe('annotateUserRetriedToolResults', () => {
  it('tells the model the user re-ran a call, on that call result only', () => {
    const annotated = annotateUserRetriedToolResults([
      MODEL_CALL,
      MODEL_RESULT,
      USER_CALL,
      USER_RESULT,
    ]);

    expect(annotated[1]).toEqual(MODEL_RESULT);
    expect(annotated[3]).toEqual({
      type: 'tool_result',
      toolCallId: 'call-user',
      content: `${USER_RETRY_NOTE}\nfile body`,
    });
  });

  it('adds one line, not one per later read', () => {
    const once = annotateUserRetriedToolResults([USER_CALL, USER_RESULT]);
    const twice = annotateUserRetriedToolResults(once);

    expect(twice).toEqual(once);
  });

  it('returns the same parts when no call was user-initiated', () => {
    const parts = [MODEL_CALL, MODEL_RESULT];

    expect(annotateUserRetriedToolResults(parts)).toBe(parts);
  });

  it('keeps an error flag on an annotated result', () => {
    const [, result] = annotateUserRetriedToolResults([
      USER_CALL,
      { ...USER_RESULT, isError: true },
    ]);

    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('file body') });
  });
});

describe('loadRichHistory with a user-initiated retry', () => {
  it('sends the model the user-retried result with the note, leaving the stored parts alone', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const stored = [MODEL_CALL, MODEL_RESULT, USER_CALL, USER_RESULT];
    await getDb()
      .insertInto('messages')
      .values({
        id: `ai-${chat.id}`,
        chatId: chat.id,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: 0,
        interactionMode: 'agent',
        parts: JSON.stringify(stored),
      })
      .execute();

    const history = await loadRichHistory(chat.id, {}, getDb());

    const resultPart = history[0]?.parts?.find(
      (part) => part.type === 'tool_result' && part.toolCallId === 'call-user'
    );
    expect(resultPart).toMatchObject({ content: `${USER_RETRY_NOTE}\nfile body` });
    const row = await getDb()
      .selectFrom('messages')
      .select('parts')
      .where('id', '=', `ai-${chat.id}`)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.parts ?? '[]')).toEqual(stored);
  });
});
