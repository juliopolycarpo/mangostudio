import { describe, expect, it } from 'bun:test';

import { type CompiledQuery, type KyselyPlugin, type PluginTransformQueryArgs, sql } from 'kysely';

import { getDb } from '../../../../src/db/database';
import {
  claimOperation,
  OperationExpiredError,
  readOperation,
  releaseOperation,
} from '../../../../src/modules/operations/application/product-operation';
import { insertTestUser } from '../../../support/factories';

const input = { prompt: 'Hello' };

function holdFirstOperationInsert() {
  const inserted = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let held: PluginTransformQueryArgs['queryId'] | undefined;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (held === undefined && args.node.kind === 'InsertQueryNode') held = args.queryId;
      return args.node;
    },
    async transformResult({ queryId, result }) {
      if (queryId === held) {
        if (result.rows.length !== 0) {
          inserted.reject(new Error('expected a conflicting insert with no returned row'));
        } else {
          inserted.resolve();
        }
        await resume.promise;
      }
      return result;
    },
  };
  return { plugin, inserted: inserted.promise, resume: resume.resolve };
}

function recordUpdates() {
  const queries: CompiledQuery[] = [];
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') {
        queries.push(getDb().getExecutor().compileQuery(args.node, args.queryId));
      }
      return args.node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  return { plugin, queries };
}

describe('product operation storage', () => {
  it('retries an identical admission after the conflicting reservation is released', async () => {
    const db = getDb();
    const user = await insertTestUser();
    const operationId = 'released-reservation';
    expect((await claimOperation(db, user.id, operationId, 'submit-turn', input)).claimed).toBe(
      true
    );
    const barrier = holdFirstOperationInsert();
    const duplicate = claimOperation(
      db.withPlugin(barrier.plugin),
      user.id,
      operationId,
      'submit-turn',
      input
    ).then(
      ({ claimed }) => ({ claimed }),
      (error: unknown) => ({ error })
    );
    try {
      await Promise.race([
        barrier.inserted,
        duplicate.then(() => {
          throw new Error('duplicate admission settled before the conflicting insert was held');
        }),
      ]);
      await releaseOperation(db, user.id, operationId);
    } finally {
      barrier.resume();
    }
    expect(await duplicate).toEqual({ claimed: true });
    expect(await readOperation(db, user.id, operationId)).toMatchObject({ state: 'accepted' });
  });

  it('plans admission cleanup through an expiry index restricted to retained snapshots', async () => {
    const db = getDb();
    const user = await insertTestUser();
    const { plugin, queries } = recordUpdates();

    await claimOperation(db.withPlugin(plugin), user.id, 'admission-cleanup', 'submit-turn', input);

    expect(queries).toHaveLength(1);
    const sweep = queries[0];
    const plan = await db.executeQuery<{ detail: string }>({
      ...sweep,
      sql: `EXPLAIN QUERY PLAN ${sweep.sql}`,
    });
    expect(plan.rows.map(({ detail }) => detail)).toEqual([
      'SEARCH product_operations USING INDEX idx_product_operations_expiresAt (expiresAt<?)',
    ]);
    const index = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE name = 'idx_product_operations_expiresAt'
    `.execute(db);
    expect(index.rows[0]?.sql).toMatch(/where "result" is not null$/i);
  });

  it('refuses an expired tombstone without issuing another cleanup update', async () => {
    const db = getDb();
    const user = await insertTestUser();
    const operationId = 'expired-tombstone';
    await claimOperation(db, user.id, operationId, 'submit-turn', input);
    await db
      .updateTable('product_operations')
      .set({ expiresAt: 0 })
      .where('userId', '=', user.id)
      .where('operationId', '=', operationId)
      .execute();
    const { plugin, queries } = recordUpdates();

    await expect(readOperation(db.withPlugin(plugin), user.id, operationId)).rejects.toBeInstanceOf(
      OperationExpiredError
    );
    expect(queries.map(({ sql: statement }) => statement)).toEqual([]);
    await expect(
      claimOperation(db, user.id, operationId, 'submit-turn', input)
    ).rejects.toBeInstanceOf(OperationExpiredError);
  });
});
