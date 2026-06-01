/**
 * Hidden `__serve` command: the foreground server of the detached child.
 *
 * Reached only when `serve -d` re-execs this binary. It never re-detaches and
 * never opens a log file (its stdout/stderr are already redirected by the parent
 * to ~/.mango/logs). API_HOST, API_PORT, and MANGO_LOG_FILE arrive via the
 * child's env.
 */

import { getAuthSecretValidationMessage, getConfig } from '../../lib/config';
import type { ServeArgs } from '../args';
import { CliError } from '../errors';

/** Run the server in the foreground of the detached child. // Usage: await runServeInternal({ port: 3000, detached: false }) */
export async function runServeInternal(args: ServeArgs): Promise<void> {
  if (args.port !== undefined) {
    process.env.API_PORT = String(args.port);
  }
  if (args.host !== undefined) {
    process.env.API_HOST = args.host;
  }
  assertServeConfig();
  const { startServer } = await import('../../server/start-server');
  await startServer({ writeStateFile: true });
}

function assertServeConfig(): void {
  const message = getAuthSecretValidationMessage(getConfig().auth.secret);
  if (message) {
    throw new CliError(
      `${message} Set it to a unique random value before running mangostudio serve.`
    );
  }
}
