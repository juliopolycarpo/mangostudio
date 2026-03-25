import { Elysia } from 'elysia';

type ApiTestPlugin = Parameters<Elysia['use']>[0];

/**
 * Creates a minimal Elysia app with the given plugins for route tests.
 *
 * @param plugins - Plugins to register on the test app instance.
 * @returns An Elysia app configured for request handling in tests.
 */
export function createApiTestApp(...plugins: ApiTestPlugin[]) {
  const app = new Elysia();

  for (const plugin of plugins) {
    app.use(plugin);
  }

  return app;
}
