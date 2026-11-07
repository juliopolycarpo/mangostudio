import { describe, expect, it } from 'bun:test';

import { type KyselyPlugin, type PluginTransformQueryArgs } from 'kysely';

import { getDb } from '../../../../src/db/database';
import {
  claimOperation,
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
});
