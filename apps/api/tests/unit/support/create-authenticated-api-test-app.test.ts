import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { getAuth, resetAuth } from '../../../src/auth';
import * as database from '../../../src/db/database';
import { loadConfigForTest } from '../../../src/lib/config';
import {
  authRunsOverRealDatabase,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import { BASE_TEST_AUTH } from '../../support/setup/test-environment';

const USER = { id: 'harness-user', name: 'Harness', email: 'harness@mangostudio.test' };

/** What the respond-stream suites install: query-builder methods only, no `withoutPlugins`. */
const FAKE_STREAM_DATABASE = { selectFrom: () => ({}) } as unknown as ReturnType<
  typeof database.getDb
>;

/** Names which database the memoized auth instance runs over, so a failure reads as a value. */
function describeAuthDatabase(): 'real database' | 'fake database' {
  return authRunsOverRealDatabase(getAuth()) ? 'real database' : 'fake database';
}

afterEach(() => {
  // `getAuth()` is process-wide state: leave none of these tests' instances behind.
  resetAuth();
});

describe('createAuthenticatedApiTestApp', () => {
  it('names the missing auth secret instead of failing only for the first caller', () => {
    // Bare defaults carry an empty secret, as a stray `loadConfigForTest({})` leaves it.
    loadConfigForTest({});

    expect(() => createAuthenticatedApiTestApp(USER)).toThrow(
      /\(createAuthenticatedApiTestApp\): expected config\.auth\.secret to be a valid test secret \| received: BETTER_AUTH_SECRET is required/
    );
  });

  it('builds the app when the config keeps the base auth block', () => {
    loadConfigForTest({ auth: { ...BASE_TEST_AUTH } });

    const { restore } = createAuthenticatedApiTestApp(USER);
    restore();
  });

  describe('restore() after more than one mount in a test', () => {
    // A test that mounts twice and keeps only the last restore (a single `restoreAuth`
    // variable) used to reinstate the first mount's mock, which then answered every later
    // file in the unisolated lane as a signed-in user: unauthenticated routes returned 200.
    it('puts back the real getSession when only the last of two mounts is restored', () => {
      loadConfigForTest({ auth: { ...BASE_TEST_AUTH } });
      const auth = getAuth();
      const realGetSession = auth.api.getSession;

      createAuthenticatedApiTestApp(USER);
      const { restore } = createAuthenticatedApiTestApp(USER);
      restore();

      expect(
        auth.api.getSession === realGetSession,
        '(createAuthenticatedApiTestApp restore): expected auth.api.getSession to be the real one | received: a mock session from an earlier mount that was never restored'
      ).toBe(true);
    });
  });

  describe('with getDb faked before the first getAuth() call', () => {
    it('drops the auth instance built over the fake when the test restores', () => {
      loadConfigForTest({ auth: { ...BASE_TEST_AUTH } });
      resetAuth();
      const getDbSpy = spyOn(database, 'getDb').mockReturnValue(FAKE_STREAM_DATABASE);

      const { restore } = createAuthenticatedApiTestApp(USER);
      restore();
      getDbSpy.mockRestore();

      // The next file's first Better Auth call must run over the real database.
      expect(describeAuthDatabase()).toBe('real database');
    });

    it('keeps an auth instance that already runs over the real database', () => {
      loadConfigForTest({ auth: { ...BASE_TEST_AUTH } });
      resetAuth();
      const warmedAuth = getAuth();
      const getDbSpy = spyOn(database, 'getDb').mockReturnValue(FAKE_STREAM_DATABASE);

      const { restore } = createAuthenticatedApiTestApp(USER);
      restore();
      getDbSpy.mockRestore();

      expect(getAuth() === warmedAuth).toBe(true);
    });

    it('names src/db/database when an earlier test left a fake-backed instance behind', () => {
      loadConfigForTest({ auth: { ...BASE_TEST_AUTH } });
      resetAuth();
      const getDbSpy = spyOn(database, 'getDb').mockReturnValue(FAKE_STREAM_DATABASE);
      getAuth(); // memoized over the fake, and never restored
      getDbSpy.mockRestore();

      expect(() => createAuthenticatedApiTestApp(USER)).toThrow(
        /\(createAuthenticatedApiTestApp\): expected Better Auth to run over the real database \| received: an instance memoized while 'src\/db\/database' getDb was faked/
      );
      // The throw dropped the instance, so the retry is clean.
      expect(describeAuthDatabase()).toBe('real database');
    });
  });
});
