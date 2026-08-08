import { describe, expect, it } from 'bun:test';
import {
  buildRespondStreamRequest,
  createSubagentDelegationError,
  mockDbWithFullCapture,
  mockPassThroughDb,
} from './_respond-stream-helpers';

describe('respond stream test helpers', () => {
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
