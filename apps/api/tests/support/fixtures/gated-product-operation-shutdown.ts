import { sql } from 'kysely';

import { getDb } from '../../../src/db/database';
import { trackProductOperationWork } from '../../../src/modules/operations/application/product-operation-work';

const finish = Promise.withResolvers<void>();
const work = finish.promise.then(async () => {
  await sql`CREATE TABLE fixture_finished_product_operation (finished INTEGER)`.execute(getDb());
});

// Tracking subscribes once to remove settled work. The next observer is the
// shutdown drain. Report that exact checkpoint before the gate can resolve.
const observe = work.then.bind(work);
let observers = 0;
work.then = (...callbacks) => {
  if (++observers === 2) console.warn('shutdown-fixture: waiting for tracked product operation');
  return observe(...callbacks);
};

trackProductOperationWork(work);
process.once('SIGUSR2', () => finish.resolve());
