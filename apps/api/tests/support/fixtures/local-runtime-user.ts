/**
 * One user, and one Local runtime connection, for a whole test file.
 *
 * Tests that reach the filesystem through the Local runtime should call this
 * once from `beforeAll`: the manager keys connections by
 * `(userId, environmentId)` — so a fresh user per test means a fresh
 * in-process runtime host per test, plus the single-owner attestation churn of
 * closing and reopening one each time. That churn is real logic, and it is
 * covered directly in the connection-manager unit tests; what it bought the
 * files that paid it was making every test depend on a connect none of them
 * assert anything about. Connecting once in setup also means a connect that
 * goes wrong fails the file loudly, once, instead of timing out each test in
 * turn with the cause thrown away.
 */

import { getRuntimeClient } from '../../../src/services/runtime-client';
import { insertTestUser, type UserFixture } from '../factories';

export async function insertUserWithLocalRuntime(): Promise<UserFixture> {
  const user = await insertTestUser();
  await getRuntimeClient(user.id);
  return user;
}
