/**
 * Listening on an ephemeral port for tests that dial the app over the network.
 */

/** The part of an Elysia app this helper drives. */
interface ListenableApp {
  listen(port: number, callback: (server: { port?: number }) => void): unknown;
}

const PUBLISH_TIMEOUT_MS = 5_000;

/**
 * Starts `app` on an ephemeral port and resolves with that port once every
 * route — WebSocket upgrades included — can be served.
 *
 * Elysia 2 binds the port synchronously but publishes its fetch and WebSocket
 * handlers later, and an upgrade that arrives in between is answered with a
 * 400. The listen callback runs only after that publish, so awaiting it is
 * what closes the window; reading `app.server.port` right after `listen()`
 * does not.
 *
 * // Usage: const port = await listenOnEphemeralPort(app);
 * //        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
 */
export function listenOnEphemeralPort(app: ListenableApp): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `expected Elysia to publish its handlers within ${PUBLISH_TIMEOUT_MS}ms | received: no listen callback`
        )
      );
    }, PUBLISH_TIMEOUT_MS);
    app.listen(0, (server) => {
      clearTimeout(timer);
      if (typeof server.port === 'number') {
        resolve(server.port);
        return;
      }
      reject(new Error(`expected a numeric listening port | received: ${String(server.port)}`));
    });
  });
}
