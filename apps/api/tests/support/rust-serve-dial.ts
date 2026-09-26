/**
 * Dialling a real `mangostudio-runtime serve` from a test: a free loopback port
 * to hand it, and a retry for the moment between spawning it and it listening.
 */

/**
 * An unused TCP port on loopback, released back to the OS before returning.
 *
 * @example
 * const port = reserveEphemeralPort();
 * Bun.spawn({ cmd: [binary, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'] });
 */
export function reserveEphemeralPort(): number {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        /* unused */
      },
      data() {
        /* unused */
      },
      close() {
        /* unused */
      },
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

/**
 * Retries the real Hub dial until `serve` is listening, rethrowing the last
 * failure once `timeoutMs` passes. `serve` logs nothing on a successful bind,
 * so retrying the production call is both the readiness check and the
 * assertion.
 *
 * Not a bare TCP probe: a connect-then-close was measured to leave a freshly
 * spawned binary refusing every WebSocket upgrade for seconds afterwards, even
 * while `ss` showed it bound and listening.
 *
 * @example
 * await connectUntilListening(() => service.connect(userId, environmentId));
 */
export async function connectUntilListening<T>(
  attempt: () => Promise<T>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}
