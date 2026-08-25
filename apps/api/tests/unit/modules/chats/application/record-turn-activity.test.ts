import { afterEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../../src/db/database';
import { recordTurnCompletedActivity } from '../../../../../src/modules/chats/application/record-turn-activity';
import { insertTestChat, insertTestUser } from '../../../../support/factories';

afterEach(async () => {
  await getDb()
    .deleteFrom('activity_events')
    .where('userId', 'like', 'turn-activity-user-%')
    .execute();
});

describe('recordTurnCompletedActivity', () => {
  it('writes a turn_completed row carrying the chat title and runner', async () => {
    const user = await insertTestUser({ id: 'turn-activity-user-1' });
    const chat = await insertTestChat(user.id, { title: 'Fix the flaky test' });

    await recordTurnCompletedActivity(user.id, chat.id, getDb());

    const row = await getDb()
      .selectFrom('activity_events')
      .selectAll()
      .where('userId', '=', user.id)
      .where('kind', '=', 'turn_completed')
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(row?.chatId).toBe(chat.id);
    const payload = JSON.parse(row?.payloadJson ?? '{}');
    expect(payload.title).toBe('Fix the flaky test');
    expect(payload.runner).toEqual({ kind: 'mangostudio', agentId: 'default' });
  });

  it('does nothing when the chat cannot be found', async () => {
    const user = await insertTestUser({ id: 'turn-activity-user-2' });

    await recordTurnCompletedActivity(user.id, 'missing-chat', getDb());

    const row = await getDb()
      .selectFrom('activity_events')
      .selectAll()
      .where('userId', '=', user.id)
      .executeTakeFirst();

    expect(row).toBeUndefined();
  });
});
