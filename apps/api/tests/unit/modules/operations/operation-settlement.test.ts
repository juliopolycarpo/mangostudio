import { describe, expect, it } from 'bun:test';

import { sql } from 'kysely';

import { getDb } from '../../../../src/db/database';
import { drainOperationStream } from '../../../../src/modules/operations/application/drain-operation-stream';
import {
  claimOperation,
  finishOperation,
  OperationExpiredError,
  readOperation,
} from '../../../../src/modules/operations/application/product-operation';
import { insertTestUser } from '../../../support/factories';

async function rejectTerminalReceiptWrites() {
  const db = getDb();
  await sql`CREATE TRIGGER reject_terminal_receipt
    BEFORE UPDATE OF state ON product_operations
    WHEN NEW.state IN ('completed', 'failed', 'unresolved')
    BEGIN SELECT RAISE(ABORT, 'controlled terminal receipt write failure'); END`.execute(db);
  return async () => {
    await sql`DROP TRIGGER reject_terminal_receipt`.execute(db);
  };
}

describe('terminal receipt recovery', () => {
  it.each([
    ['completed', 'data: {"type":"done","done":true,"messageId":"answer"}\n\n', 'answer'],
    ['failed', 'data: {"type":"error","error":"controlled provider failure"}\n\n', null],
    ['unresolved', null, null],
  ] as const)('persists %s after terminal writes recover', async (state, stream, messageId) => {
    const db = getDb();
    const user = await insertTestUser();
    const other = await insertTestUser();
    const operationId = `settle-${state}`;
    const input = { prompt: 'Hello' };
    await claimOperation(db, user.id, operationId, 'submit-turn', input);
    await claimOperation(db, other.id, operationId, 'submit-turn', input);
    await finishOperation(db, user.id, operationId, 'running');

    const allowWrites = await rejectTerminalReceiptWrites();
    let drainError: unknown;
    try {
      await drainOperationStream(new Response(stream), db, user.id, operationId).catch(
        (error: unknown) => {
          drainError = error;
        }
      );
      expect(await readOperation(db, user.id, operationId)).toMatchObject({ state: 'running' });
    } finally {
      await allowWrites();
    }

    expect(await readOperation(db, other.id, operationId)).toMatchObject({ state: 'accepted' });
    expect(await readOperation(db, user.id, operationId)).toMatchObject({ state, messageId });
    expect(drainError).toBeUndefined();
    expect(await claimOperation(db, user.id, operationId, 'submit-turn', input)).toMatchObject({
      claimed: false,
      row: { state, messageId },
    });
  });

  it('discards a pending verdict once the operation expires', async () => {
    const db = getDb();
    const user = await insertTestUser();
    const operationId = 'expire-pending-receipt';
    await claimOperation(db, user.id, operationId, 'submit-turn', { prompt: 'Hello' });
    const allowWrites = await rejectTerminalReceiptWrites();
    try {
      await drainOperationStream(
        new Response('data: {"type":"done","done":true,"messageId":"expired-answer"}\n\n'),
        db,
        user.id,
        operationId
      );
    } finally {
      await allowWrites();
    }

    await db
      .updateTable('product_operations')
      .set({ expiresAt: 0 })
      .where('userId', '=', user.id)
      .where('operationId', '=', operationId)
      .execute();
    await expect(readOperation(db, user.id, operationId)).rejects.toBeInstanceOf(
      OperationExpiredError
    );
    const stored = await db
      .selectFrom('product_operations')
      .select(['state', 'messageId'])
      .where('userId', '=', user.id)
      .where('operationId', '=', operationId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ state: 'accepted', messageId: null });
  });
});
