import { describe, expect, it } from 'bun:test';

import { ActivityEventSchema } from '@mangostudio/shared/activity';
import Value from 'typebox/value';

import type { getDb } from '../../../src/db/database';
import {
  ACTIVITY_RETENTION_MS,
  createActivityRepository,
} from '../../../src/modules/activity/infrastructure/activity-repository';
import { recordTurnCompletedActivity } from '../../../src/modules/chats/application/record-turn-activity';
import { ActivityInsertCapture } from '../../support/activity-insert-capture';
import {
  buildRespondStreamRequest,
  createSubagentDelegationError,
  createTestStreamDb,
  mockDbWithFullCapture,
  mockPassThroughDb,
} from './_respond-stream-helpers';

describe('respond stream test helpers', () => {
  it('records a schema-valid completed activity through the shared stream database', async () => {
    const capture = new ActivityInsertCapture();
    const messages: Array<Record<string, unknown>> = [];
    const db = createTestStreamDb({
      userId: 'user-1',
      insertedMessages: messages,
      onInsert: capture.onInsert,
    });
    await insertMessage(db, { role: 'ai', text: 'Still captured' });
    await recordTurnCompletedActivity(
      'user-1',
      'chat-1',
      db as unknown as ReturnType<typeof getDb>
    );

    expect(capture.rows).toHaveLength(1);
    const row = capture.rows[0];
    const payload = JSON.parse(row?.payloadJson as string) as unknown;
    expect(
      Value.Check(ActivityEventSchema, { ...row, payload }),
      `expected ActivityEventSchema completed turn | received: ${JSON.stringify({ ...row, payload })}`
    ).toBe(true);
    expect(row).toMatchObject({ userId: 'user-1', chatId: 'chat-1', kind: 'turn_completed' });
    expect(payload).toEqual({
      title: 'Stream test chat',
      runner: { kind: 'mangostudio', agentId: 'default' },
    });
    expect(messages).toEqual([{ role: 'ai', text: 'Still captured' }]);
  });

  it('records chat overrides and keeps unrelated reads empty', async () => {
    const capture = new ActivityInsertCapture();
    const db = createTestStreamDb({
      userId: 'user-1',
      chatOverrides: { id: 'renamed-chat', title: 'Renamed', lastProviderState: 'cursor' },
      onInsert: capture.onInsert,
    });
    await recordTurnCompletedActivity(
      'user-1',
      'renamed-chat',
      db as unknown as ReturnType<typeof getDb>
    );
    expect(capture.rows).toHaveLength(1);
    const row = capture.rows[0];
    const payload = JSON.parse(row?.payloadJson as string) as unknown;
    expect(
      Value.Check(ActivityEventSchema, { ...row, payload }),
      `expected ActivityEventSchema completed turn | received: ${JSON.stringify({ ...row, payload })}`
    ).toBe(true);
    expect(row?.chatId).toBe('renamed-chat');
    expect(payload).toEqual({
      title: 'Renamed',
      runner: { kind: 'mangostudio', agentId: 'default' },
    });
    const select = db.selectFrom as (table: string) => { executeTakeFirst(): Promise<unknown> };
    expect(await select('chats').executeTakeFirst()).toMatchObject({ lastProviderState: 'cursor' });
    expect(await select('activity_events').executeTakeFirst()).toBeUndefined();
    expect(await select('environment_toolchains').executeTakeFirst()).toBeUndefined();
  });

  it('captures only bulk activity inserts', () => {
    const capture = new ActivityInsertCapture();
    capture.onInsert('messages', { text: 'not activity' });
    expect(capture.rows).toEqual([]);
    expect(() => capture.onInsert('activity_events', {})).toThrow('expected an array of rows');
  });

  it('refuses retention deletion from unrelated tables', () => {
    const db = mockPassThroughDb('user-1')().getDb();
    const deleteFrom = db.deleteFrom as (table: string) => unknown;

    expect(() => deleteFrom('messages')).toThrow(
      'stream database: expected activity_events deletion | received: messages'
    );
  });

  it('supports activity retention without returning a chat as an activity row', async () => {
    const db = mockPassThroughDb('user-1')().getDb();
    const repository = createActivityRepository(db as unknown as ReturnType<typeof getDb>);

    await repository.prune('user-1', ACTIVITY_RETENTION_MS + 1);
    const selectFrom = db.selectFrom as (table: string) => {
      executeTakeFirst: () => Promise<unknown>;
    };
    expect(await selectFrom('activity_events').executeTakeFirst()).toBeUndefined();
  });

  it('builds JSON POST requests for the streaming endpoint', async () => {
    const request = buildRespondStreamRequest({ chatId: 'chat-1', prompt: 'Hello' });

    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://localhost/respond/stream');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.json()).toEqual({ chatId: 'chat-1', prompt: 'Hello' });
  });

  it('captures message inserts and chat updates in database mocks', async () => {
    const dbMock = mockDbWithFullCapture('user-1');
    const db = dbMock.moduleFactory().getDb();

    await insertMessage(db, { role: 'ai', text: 'Hello' });
    await updateMessage(db, { text: 'Complete', isGenerating: 0 });
    await updateChat(db, { lastProviderState: null });

    expect(dbMock.insertedMessages).toEqual([{ role: 'ai', text: 'Complete', isGenerating: 0 }]);
    expect(dbMock.chatSetCalls).toEqual([{ lastProviderState: null }]);
  });

  it('keeps pass-through database mocks write-only', async () => {
    const db = mockPassThroughDb('user-1')().getDb();

    await insertMessage(db, { role: 'ai', text: 'Ignored' });
    const row = await executeOwnershipLookup(db);

    // The pre-flight read is `getOwnedChat`, which maps the runner columns
    // into the typed union, so the stand-in row has to carry them: a bare
    // `{ userId }` reads as a corrupt runner configuration.
    expect(row).toEqual({
      id: 'chat-1',
      title: 'Stream test chat',
      lastProviderState: null,
      userId: 'user-1',
      runnerKind: 'mangostudio',
      runnerAgentId: 'default',
      runnerTargetId: null,
      workdir: null,
      environmentId: 'local',
      restrictToolsToWorkdir: null,
    });
  });

  it('creates the subagent delegation error class used by runner mocks', () => {
    const SubagentDelegationError = createSubagentDelegationError();
    const error = new SubagentDelegationError('No output', 'EMPTY_RESULT');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SubagentDelegationError');
    expect(error.code).toBe('EMPTY_RESULT');
  });
});

async function insertMessage(
  db: Record<string, unknown>,
  values: Record<string, unknown>
): Promise<void> {
  const insertInto = db.insertInto as (table: string) => Record<string, unknown>;
  const insert = insertInto('messages');
  const setValues = insert.values as (values: Record<string, unknown>) => {
    execute: () => Promise<void>;
  };

  await setValues(values).execute();
}

async function updateChat(
  db: Record<string, unknown>,
  values: Record<string, unknown>
): Promise<void> {
  const updateTable = db.updateTable as (table: string) => Record<string, unknown>;
  const update = updateTable('chats');
  const setValues = update.set as (values: Record<string, unknown>) => Record<string, unknown>;
  const chain = setValues(values);
  const execute = chain.execute as () => Promise<unknown>;

  await execute();
}

async function updateMessage(
  db: Record<string, unknown>,
  values: Record<string, unknown>
): Promise<void> {
  const updateTable = db.updateTable as (table: string) => Record<string, unknown>;
  const update = updateTable('messages');
  const setValues = update.set as (values: Record<string, unknown>) => Record<string, unknown>;
  const chain = setValues(values);
  const execute = chain.execute as () => Promise<unknown>;

  await execute();
}

function executeOwnershipLookup(db: Record<string, unknown>): Promise<unknown> {
  const selectFrom = db.selectFrom as () => Record<string, unknown>;
  const chain = selectFrom();
  const executeTakeFirst = chain.executeTakeFirst as () => Promise<unknown>;

  return executeTakeFirst();
}
