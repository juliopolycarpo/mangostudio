/**
 * Hidden `__serve` command: the foreground server of the detached child.
 *
 * Reached only when `serve -d` re-execs this binary. It never re-detaches and
 * never opens a log file (its stdout/stderr are already redirected by the parent
 * to ~/.mango/logs). API_HOST, API_PORT, and MANGO_LOG_FILE arrive via the
 * child's env.
 */

import type { ServeArgs } from '../args';

/** Run the server in the foreground of the detached child. // Usage: await runServeInternal({ port: 3000, detached: false }) */
export async function runServeInternal(args: ServeArgs): Promise<void> {
  if (args.port !== undefined) {
    process.env.API_PORT = String(args.port);
  }
  if (args.host !== undefined) {
    process.env.API_HOST = args.host;
  }
  const { startServer } = await import('../../server/start-server');
  await startServer({ writeStateFile: true });
}
