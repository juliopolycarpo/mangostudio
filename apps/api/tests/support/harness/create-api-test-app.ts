import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';
import { getAuth } from '../../../src/auth';
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

  const auth = getAuth();
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
  };

  return { app, restore };
}
