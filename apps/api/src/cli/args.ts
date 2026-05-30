/**
 * Argument parsing for the `serve` command: an optional positional port and the
 * -d/--detach flag.
 */

import { CliError } from './errors';

export interface ServeArgs {
  port?: number;
  detached: boolean;
}

const PORT_MIN = 1;
const PORT_MAX = 65_535;

/** Parse `serve` args: optional positional port + -d/--detach. // Usage: parseServeArgs(['3000','-d']) */
export function parseServeArgs(rest: string[]): ServeArgs {
  let port: number | undefined;
  let detached = false;

  for (const arg of rest) {
    if (arg === '-d' || arg === '--detach') {
      detached = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliError(`Unknown option for serve: ${arg}`);
    }
    if (port !== undefined) {
      throw new CliError(`Unexpected argument: ${arg}`);
    }
    port = parsePort(arg);
  }

  return { port, detached };
}

/** Parse and validate a positional port string. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) {
    throw new CliError(`Invalid port: ${value}`);
  }
  assertValidPort(port);
  return port;
}

/** Throw a CliError when a port is outside 1..65535. // Usage: assertValidPort(3000) */
export function assertValidPort(port: number): void {
  if (port < PORT_MIN || port > PORT_MAX) {
    throw new CliError(`Port out of range (${PORT_MIN}-${PORT_MAX}): ${port}`);
  }
}
