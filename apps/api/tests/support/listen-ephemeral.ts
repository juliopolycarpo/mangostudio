/**
 * Listening on an ephemeral port for tests that dial the app over the network.
 */

/** The part of an Elysia app this helper drives. */
interface ListenableApp {
  listen(port: number, callback: (server: { port?: number }) => void): unknown;
  stop(force: boolean): Promise<void> | void;
}

const PUBLISH_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

/**
 * Stops a server started by {@link listenOnEphemeralPort} and resolves once
 * Elysia has released the app, so the same instance can `listen()` again.
 *
 * Never stop with `app.server.stop(true)`: that closes the Bun socket but
 * bypasses Elysia's teardown, which leaves `app.server` and its stop hook set.
 * Every later `listen()` on that app then throws "Cannot call listen() while a
 * server or teardown is active". That only matters for an app other files share
 * (`src/app.ts` is one module instance for the whole unisolated lane); a
 * per-test app can be dropped.
 *
 * // Usage: afterAll(() => stopEphemeralServer(app));
 */
export async function stopEphemeralServer(app: Pick<ListenableApp, 'stop'>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `expected app.stop(true) to settle within ${STOP_TIMEOUT_MS}ms | received: teardown still pending`
        )
      );
    }, STOP_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.resolve(app.stop(true)), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

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
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- This callback intentionally tests or owns the asynchronous operation described here.
    const timer = setTimeout(async () => {
      // Elysia may have bound the socket even though its publish callback did not run.
      try {
        await app.stop(true);
      } catch {
        // Preserve the publish timeout as the reported failure.
      }
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
