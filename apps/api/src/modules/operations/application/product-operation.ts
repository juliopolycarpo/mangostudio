import { createHash, randomUUID } from 'node:crypto';

import {
  OPERATION_RETENTION_MS,
  type OperationReceipt,
  type OperationState,
} from '@mangostudio/shared/operations';
import type { Kysely } from 'kysely';

import type { Database, ProductOperationsTable } from '../../../db/types';

// A new process cannot prove what its predecessor dispatched. It never replays that work.
const processOwner = randomUUID();
export class OperationConflictError extends Error {}
export class OperationExpiredError extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  return value;
}
export function operationFingerprint(kind: OperationReceipt['kind'], input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, canonical(input)]))
    .digest('hex');
}
export async function readOperation(
  db: Kysely<Database>,
  userId: string,
  operationId: string
): Promise<ProductOperationsTable | undefined> {
  const row = await db
    .selectFrom('product_operations')
    .selectAll()
    .where('userId', '=', userId)
    .where('operationId', '=', operationId)
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    await db
      .updateTable('product_operations')
      .set({ result: null })
      .where('userId', '=', userId)
      .where('operationId', '=', operationId)
      .execute();
    throw new OperationExpiredError('Operation receipt expired; this key cannot be reused.');
  }
  if (row.owner !== processOwner && (row.state === 'accepted' || row.state === 'running')) {
    await finishOperation(db, userId, operationId, 'unresolved');
    row.state = 'unresolved';
  }
  return row;
}
export function operationReceipt(row: ProductOperationsTable): OperationReceipt {
  return {
    operationId: row.operationId,
    kind: row.kind,
    state: row.state,
    chatId: row.chatId,
    messageId: row.messageId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
export async function claimOperation(
  db: Kysely<Database>,
  userId: string,
  operationId: string,
  kind: OperationReceipt['kind'],
  input: unknown,
  chatId: string | null = null
) {
  const fingerprint = operationFingerprint(kind, input);
  const now = Date.now();
  await db
    .updateTable('product_operations')
    .set({ result: null })
    .where('expiresAt', '<=', now)
    .where('result', 'is not', null)
    .execute();
  const inserted = await db
    .insertInto('product_operations')
    .values({
      userId,
      operationId,
      kind,
      fingerprint,
      owner: processOwner,
      state: 'accepted',
      chatId,
      messageId: null,
      result: null,
      createdAt: now,
      expiresAt: now + OPERATION_RETENTION_MS,
    })
    .onConflict((oc) => oc.columns(['userId', 'operationId']).doNothing())
    .returningAll()
    .executeTakeFirst();
  const row = inserted ?? (await readOperation(db, userId, operationId));
  if (row?.fingerprint !== fingerprint || row.kind !== kind)
    throw new OperationConflictError('Operation ID already belongs to different input.');
  return { row, claimed: Boolean(inserted) };
}
export async function finishOperation(
  db: Kysely<Database>,
  userId: string,
  operationId: string,
  state: OperationState,
  messageId?: string
) {
  await db
    .updateTable('product_operations')
    .set({ state, ...(messageId ? { messageId } : {}) })
    .where('userId', '=', userId)
    .where('operationId', '=', operationId)
    .execute();
}
export async function releaseOperation(db: Kysely<Database>, userId: string, operationId: string) {
  await db
    .deleteFrom('product_operations')
    .where('userId', '=', userId)
    .where('operationId', '=', operationId)
    .where('state', '=', 'accepted')
    .execute();
}
