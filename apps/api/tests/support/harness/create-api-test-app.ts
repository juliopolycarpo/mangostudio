import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';

import { getAuth, resetAuth } from '../../../src/auth';
import { getDb } from '../../../src/db/database';
import { getAuthSecretValidationMessage, getConfig } from '../../../src/lib/config';
import { REALTIME_WEBSOCKET_OPTIONS } from '../../../src/modules/realtime/http/realtime-routes';
import { assertTestEnvironmentReady } from '../setup/test-environment';

type ApiTestPlugin = Parameters<Elysia['use']>[0];

/**
 * Creates a minimal Elysia app with the given plugins for route tests.
 *
 * @param plugins - Plugins to register on the test app instance.
 * @returns An Elysia app configured for request handling in tests.
 */
export function createApiTestApp(...plugins: ApiTestPlugin[]) {
  assertTestEnvironmentReady('createApiTestApp');

  // WebSocket support is a plugin in Elysia 2, and both socket protocols are
  // built as independent route plugins. Registering it here keeps one builder
  // for every route test instead of a second, divergent socket-only one; it is
  // inert for the suites that never open a socket.
  const app = new Elysia().use(websocket(REALTIME_WEBSOCKET_OPTIONS));

  for (const plugin of plugins) {
    app.use(plugin);
  }

  return app;
}

/**
 * A real Kysely instance has `withoutPlugins`; the stream suites' fake databases
 * (`createTestStreamDb`, a bare `{ selectFrom }`) do not. Better Auth's schema check
 * calls it, so the method is the line between the two.
 */
function isRealKysely(candidate: unknown): boolean {
  return (
    typeof (candidate as { withoutPlugins?: unknown } | undefined)?.withoutPlugins === 'function'
  );
}

/**
 * Whether `auth` runs over the real database. `getAuth()` memoizes the first instance for the
 * whole process, so one built while a test had `getDb` faked (`spyOn` or `mockModule` of
 * `src/db/database`) keeps that fake for every later file in the unisolated integration lane.
 * Every route that reaches Better Auth then fails with `db.withoutPlugins is not a function`.
 * // Usage: if (!authRunsOverRealDatabase(getAuth())) resetAuth();
 */
export function authRunsOverRealDatabase(auth: ReturnType<typeof getAuth>): boolean {
  const database = auth.options.database as { db?: unknown } | undefined;
  return isRealKysely(database?.db);
}

/**
 * Creates a test app that bypasses auth by temporarily monkey-patching
 * `auth.api.getSession` to return the given mock user.
 *
 * Returns the app and a `restore()` function. Always call `restore()` in
 * `afterEach`/`finally` to prevent the mock from leaking into other tests.
 *
 * @param mockUser - User object to return from the mock session.
 * @param plugins  - Route plugins to mount on the test app.
 */
export function createAuthenticatedApiTestApp(
  mockUser: { id: string; name: string; email: string },
  ...plugins: ApiTestPlugin[]
) {
  assertTestEnvironmentReady('createAuthenticatedApiTestApp');

  // `getAuth()` memoizes on first call, so a config without a usable secret only
  // fails for whichever test reaches it first — an order dependence. Fail every
  // time instead, naming the cause.
  const secretProblem = getAuthSecretValidationMessage(getConfig().auth.secret);
  if (secretProblem) {
    throw new Error(
      `(createAuthenticatedApiTestApp): expected config.auth.secret to be a valid test secret | received: ${secretProblem} ` +
        'A loadConfigForTest(...) call without `auth: BASE_TEST_AUTH` replaced the base test config.'
    );
  }

  const auth = getAuth();
  if (!authRunsOverRealDatabase(auth) && isRealKysely(getDb())) {
    // The database is real again, so this instance was memoized under a fake by an earlier test
    // that never called its `restore()`. Drop it so the next caller rebuilds, and fail here
    // with the cause instead of in whichever later file first signs a user up.
    resetAuth();
    throw new Error(
      "(createAuthenticatedApiTestApp): expected Better Auth to run over the real database | received: an instance memoized while 'src/db/database' getDb was faked (spyOn or mockModule) and never restored; it was dropped, so re-run. Call the returned restore() in afterEach."
    );
  }
  const api = auth.api as Record<string, unknown>;
  const originalGetSession = auth.api.getSession.bind(auth.api);

  api.getSession = () =>
    Promise.resolve({
      user: {
        id: mockUser.id,
        name: mockUser.name,
        email: mockUser.email,
        createdAt: new Date(),
        updatedAt: new Date(),
        image: null,
        emailVerified: false,
      },
      session: {
        id: 'test-session-id',
        userId: mockUser.id,
        token: 'test-token',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
    });

  const app = createApiTestApp(...plugins);

  const restore = () => {
    api.getSession = originalGetSession;
    // A suite that fakes `getDb` before building its app can be the first caller of
    // `getAuth()`, which memoizes an instance over the fake. Dropping it here keeps the fake
    // from outliving the test; an instance already over the real database stays.
    if (!authRunsOverRealDatabase(auth)) resetAuth();
  };

  return { app, restore };
}
