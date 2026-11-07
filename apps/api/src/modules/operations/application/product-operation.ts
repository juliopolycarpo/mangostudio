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
type TerminalState = Exclude<OperationState, 'accepted' | 'running'>;
type TerminalReceipt = { state: TerminalState; messageId?: string };
type PendingReceipt = TerminalReceipt & { timer: ReturnType<typeof setTimeout> };
const pendingReceipts = new WeakMap<Kysely<Database>, Map<string, PendingReceipt>>();

function receiptKey(userId: string, operationId: string) {
  return JSON.stringify([userId, operationId]);
}

function clearPendingReceipt(
  receipts: Map<string, PendingReceipt> | undefined,
  key: string,
  pending: PendingReceipt | undefined
) {
  if (pending && receipts?.get(key) === pending) {
    clearTimeout(pending.timer);
    receipts.delete(key);
  }
}

function writeTerminalReceipt(
  db: Kysely<Database>,
  userId: string,
  operationId: string,
  { state, messageId }: TerminalReceipt
) {
  return db
    .updateTable('product_operations')
    .set({ state, ...(messageId ? { messageId } : {}) })
    .where('userId', '=', userId)
    .where('operationId', '=', operationId)
    .where('owner', '=', processOwner)
    .where('expiresAt', '>', Date.now())
    .where('state', 'in', ['accepted', 'running'])
    .returningAll()
    .executeTakeFirst();
}

/**
 * Persist an admitted operation's terminal verdict, retaining it for lookup if the write fails.
 * @example await settleOperation(db, userId, operationId, 'completed', messageId);
 */
export async function settleOperation(
  db: Kysely<Database>,
  userId: string,
  operationId: string,
  state: TerminalState,
  messageId?: string
): Promise<void> {
  try {
    await writeTerminalReceipt(db, userId, operationId, { state, messageId });
  } catch (error) {
    console.error('[operation] Could not persist terminal receipt', error);
    let receipts = pendingReceipts.get(db);
    if (!receipts) {
      receipts = new Map();
      pendingReceipts.set(db, receipts);
    }
    const key = receiptKey(userId, operationId);
    if (!receipts.has(key)) {
      const timer = setTimeout(() => receipts.delete(key), OPERATION_RETENTION_MS);
      timer.unref();
      receipts.set(key, { state, messageId, timer });
    }
  }
}

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
/**
 * Read a user's reservation, optionally restricting public lookup to accessible chats.
 * @example await readOperation(db, userId, operationId, { requireOwnedChat: true });
 */
export async function readOperation(
  db: Kysely<Database>,
  userId: string,
  operationId: string,
  { requireOwnedChat = false } = {}
): Promise<ProductOperationsTable | undefined> {
  let query = db
    .selectFrom('product_operations')
    .selectAll()
    .where('userId', '=', userId)
    .where('operationId', '=', operationId);
  if (requireOwnedChat) {
    query = query.where(({ eb, exists, or, selectFrom }) =>
      or([
        eb('chatId', 'is', null),
        exists(
          selectFrom('chats')
            .select('chats.id')
            .whereRef('chats.id', '=', 'product_operations.chatId')
            .whereRef('chats.userId', '=', 'product_operations.userId')
        ),
      ])
    );
  }
  const row = await query.executeTakeFirst();
  if (!row) return undefined;

  // Claim callers may be inside a transaction. Leave recovery to a committed lookup.
  const receipts = db.isTransaction ? undefined : pendingReceipts.get(db);
  const key = receiptKey(userId, operationId);
  const pending = receipts?.get(key);
  if (row.expiresAt <= Date.now()) {
    clearPendingReceipt(receipts, key, pending);
    if (row.result !== null) {
      await db
        .updateTable('product_operations')
        .set({ result: null })
        .where('userId', '=', userId)
        .where('operationId', '=', operationId)
        .where('result', 'is not', null)
        .execute();
    }
    throw new OperationExpiredError('Operation receipt expired; this key cannot be reused.');
  }
  if (row.state !== 'accepted' && row.state !== 'running') {
    clearPendingReceipt(receipts, key, pending);
  } else if (row.owner !== processOwner) {
    clearPendingReceipt(receipts, key, pending);
    await finishOperation(db, userId, operationId, 'unresolved');
    row.state = 'unresolved';
  } else if (pending) {
    let settled: ProductOperationsTable | undefined;
    try {
      settled = await writeTerminalReceipt(db, userId, operationId, pending);
    } catch {
      // Leave the verdict available for the next lookup while storage is unavailable.
      return row;
    }
    clearPendingReceipt(receipts, key, pending);
    return settled ?? readOperation(db, userId, operationId, { requireOwnedChat });
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
  await db
    .updateTable('product_operations')
    .set({ result: null })
    .where('expiresAt', '<=', Date.now())
    .where('result', 'is not', null)
    .execute();
  for (;;) {
    const now = Date.now();
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
    if (inserted) return { row: inserted, claimed: true };

    const row = await readOperation(db, userId, operationId);
    // A rejected preflight can release its reservation between the insert and read.
    if (!row) continue;
    if (row.fingerprint !== fingerprint || row.kind !== kind)
      throw new OperationConflictError('Operation ID already belongs to different input.');
    return { row, claimed: false };
  }
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
