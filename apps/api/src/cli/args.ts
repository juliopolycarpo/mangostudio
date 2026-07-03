/**
 * Argument parsing for the `serve` command: an optional positional port/host and
 * the -d/--detach flag.
 */

import { CliError } from './errors';

export interface ServeArgs {
  host?: string;
  port?: number;
  detached: boolean;
}

export interface DoctorArgs {
  all: boolean;
  cursorProbe: boolean;
  chatgptRefresh: boolean;
}

const PORT_MIN = 1;
const PORT_MAX = 65_535;

const HOST_ALIASES: Record<string, string> = {
  all: '0.0.0.0',
  any: '0.0.0.0',
  lan: '0.0.0.0',
  local: '127.0.0.1',
  public: '0.0.0.0',
};

/** Parse `serve` args: optional host/port + -d/--detach. // Usage: parseServeArgs(['127.0.0.1:3000','-d']) */
export function parseServeArgs(rest: string[]): ServeArgs {
  let host: string | undefined;
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
    if (host !== undefined || port !== undefined) {
      throw new CliError(`Unexpected argument: ${arg}`);
    }
    ({ host, port } = parseServeTarget(arg));
  }

  return { host, port, detached };
}

/** Parse `doctor` args: optional --all, --cursor-probe, and --chatgpt-refresh flags. */
export function parseDoctorArgs(rest: string[]): DoctorArgs {
  let all = false;
  let cursorProbe = false;
  let chatgptRefresh = false;

  for (const arg of rest) {
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--cursor-probe') {
      cursorProbe = true;
      continue;
    }
    if (arg === '--chatgpt-refresh') {
      chatgptRefresh = true;
      continue;
    }
    throw new CliError(`Unknown option for doctor: ${arg}`);
  }

  return { all, cursorProbe, chatgptRefresh };
}

interface ServeTarget {
  host?: string;
  port?: number;
}

/** Parse and validate a positional serve target. // Usage: parseServeTarget('lan:3000') */
function parseServeTarget(value: string): ServeTarget {
  const split = splitHostPort(value);
  if (split) {
    return { host: parseHost(split.host), port: parsePort(split.port) };
  }
  if (/^\d+$/.test(value)) {
    return { port: parsePort(value) };
  }
  if (looksLikeInvalidNumericTarget(value)) {
    throw new CliError(`Invalid serve target: ${value}`);
  }
  return { host: parseHost(value) };
}

function looksLikeInvalidNumericTarget(value: string): boolean {
  return /^0x/i.test(value) || /^\d+e\d+$/i.test(value) || isInvalidDottedNumber(value);
}

function isInvalidDottedNumber(value: string): boolean {
  return /^\d+(?:\.\d+)+$/.test(value) && !isValidIPv4(value);
}

function splitHostPort(value: string): { host: string; port: string } | null {
  const index = value.lastIndexOf(':');
  if (index <= 0 || index === value.length - 1) {
    return null;
  }
  if (value.slice(0, index).includes(':')) {
    throw new CliError(`Invalid serve target: ${value}`);
  }
  return { host: value.slice(0, index), port: value.slice(index + 1) };
}

/** Parse and validate a positional port string. // Usage: parsePort('3000') */
function parsePort(value: string): number {
  // Require plain decimal digits: Number() would silently accept '0x10', '1e3',
  // or ' 3000 ' and bind a port the user did not type.
  if (!/^\d+$/.test(value)) {
    throw new CliError(`Invalid port: ${value}`);
  }
  const port = Number(value);
  assertValidPort(port);
  return port;
}

/** Parse and normalize a positional host string. // Usage: parseHost('lan') */
function parseHost(value: string): string {
  const host = HOST_ALIASES[value.toLowerCase()] ?? value;
  if (!isValidHost(host)) {
    throw new CliError(`Invalid host: ${value}`);
  }
  return host;
}

function isValidHost(host: string): boolean {
  if (host.length === 0 || /\s/.test(host)) {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isValidIPv4(host);
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

function isValidIPv4(host: string): boolean {
  return host.split('.').length === 4 && host.split('.').every((part) => Number(part) <= 255);
}

/** Throw a CliError when a port is outside 1..65535. // Usage: assertValidPort(3000) */
export function assertValidPort(port: number): void {
  if (port < PORT_MIN || port > PORT_MAX) {
    throw new CliError(`Port out of range (${PORT_MIN}-${PORT_MAX}): ${port}`);
  }
}
