/**
 * Argument parsing for the `serve` command: an optional positional port/host and
 * the -d/--detach flag.
 */

import {
  isUserServiceAction,
  USER_SERVICE_ACTIONS,
  type UserServiceAction,
} from '@mangostudio/runtime';
import type { ResourceKind } from '@mangostudio/shared/library';
import {
  UPGRADE_SHA_PATTERN,
  UPGRADE_VERSION_PATTERN,
  type UpdateChannel,
} from '@mangostudio/shared/updates';
import { CliError } from './errors';

export interface ServeArgs {
  host?: string;
  port?: number;
  detached: boolean;
}

export interface DoctorArgs {
  all: boolean;
  chatgptRefresh: boolean;
  /** Actively connect to each enabled MCP server (spawns children / hits URLs). */
  probe: boolean;
  /** When set, run only the Environments section (plus core checks). */
  envOnly: boolean;
  /** When set, run only the Library section (plus core checks). */
  libraryOnly: boolean;
  /** Emit structured JSON instead of plain text. */
  json: boolean;
}

export interface EnvArgs {
  subcommand: 'runtimes' | 'agents' | 'install' | 'update' | 'toolchain' | null;
  json: boolean;
  /** `toolchain` only: which runtime to pin; omitted means show the selection. */
  runtime?: 'node' | 'bun';
  /** `toolchain` only: `auto` or the path of a probed installation. */
  choice?: string;
  /** `install`/`update`/`toolchain`: the account to act as, by email; omitted means the sole account. */
  user?: string;
  /** `install`/`update` only: the recipe to run. */
  recipeId?: string;
  /** `install`/`update` only: which machine to run it on; omitted means the hub's own. */
  environmentId?: string;
  /** `install`/`update` only: a Node version spec, for a `node-version` recipe. */
  version?: string;
}

export interface StatusArgs {
  /** Emit the shared hub status document instead of plain text. */
  json: boolean;
}

// The manager's own verb list, so a verb added there is not rejected here.
export const HUB_SERVICE_ACTIONS = USER_SERVICE_ACTIONS;
export type HubServiceAction = UserServiceAction;

export interface ServiceArgs {
  action: HubServiceAction;
  /** `install` only: an explicit bind target baked into the unit. */
  host?: string;
  port?: number;
  json: boolean;
}

export interface LogsArgs {
  follow: boolean;
  lines: number;
}

export interface UpgradeArgs {
  /** Preview only: resolve and report, never download or run anything. */
  check: boolean;
  /** Skip every confirmation prompt. */
  yes: boolean;
  channel?: UpdateChannel;
  /** Stable only: an exact version instead of the latest. */
  version?: string;
  /** Canary only: a pinned source commit instead of the rolling latest. */
  sha?: string;
  rollback: boolean;
  noRestart: boolean;
  json: boolean;
}

export const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 10_000;

/** Default doctor flags for tests and internal callers. */
export const DEFAULT_DOCTOR_ARGS: DoctorArgs = {
  all: false,
  chatgptRefresh: false,
  probe: false,
  envOnly: false,
  libraryOnly: false,
  json: false,
};

type LibrarySubcommand = 'locations' | null;

export interface LibraryArgs {
  subcommand: LibrarySubcommand;
  kind?: ResourceKind;
  divergent: boolean;
  json: boolean;
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

/** Parse `doctor` args: optional --all, --chatgpt-refresh, and --probe flags. */
export function parseDoctorArgs(rest: string[]): DoctorArgs {
  let all = false;
  let chatgptRefresh = false;
  let probe = false;
  let envOnly = false;
  let libraryOnly = false;
  let json = false;

  for (const arg of rest) {
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--chatgpt-refresh') {
      chatgptRefresh = true;
      continue;
    }
    if (arg === '--probe') {
      probe = true;
      continue;
    }
    if (arg === '--env') {
      envOnly = true;
      continue;
    }
    if (arg === '--library') {
      libraryOnly = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new CliError(`Unknown option for doctor: ${arg}`);
  }

  return { all, chatgptRefresh, probe, envOnly, libraryOnly, json };
}

/** Parse `status` args: optional --json. // Usage: parseStatusArgs(['--json']) */
export function parseStatusArgs(rest: string[]): StatusArgs {
  let json = false;
  for (const arg of rest) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new CliError(`Unknown option for status: ${arg}`);
  }
  return { json };
}

/** Parse `service` args: an action, an install target, --json. // Usage: parseServiceArgs(['install', 'lan:3000']) */
export function parseServiceArgs(rest: string[]): ServiceArgs {
  const [action, ...options] = rest;
  if (action === undefined) {
    throw new CliError(
      `Missing service action. Expected one of: ${HUB_SERVICE_ACTIONS.join(', ')}`
    );
  }
  if (!isUserServiceAction(action)) {
    throw new CliError(
      `Unknown service action: ${action}. Expected one of: ${HUB_SERVICE_ACTIONS.join(', ')}`
    );
  }

  let json = false;
  let host: string | undefined;
  let port: number | undefined;
  for (const arg of options) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliError(`Unknown option for service: ${arg}`);
    }
    if (action !== 'install') {
      throw new CliError(`Unexpected argument for service ${action}: ${arg}`);
    }
    if (host !== undefined || port !== undefined) {
      throw new CliError(`Unexpected argument: ${arg}`);
    }
    ({ host, port } = parseServeTarget(arg));
  }

  return { action, host, port, json };
}

/** Parse `logs` args: -f/--follow and -n/--lines <count>. // Usage: parseLogsArgs(['-f', '-n', '50']) */
export function parseLogsArgs(rest: string[]): LogsArgs {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '-f' || arg === '--follow') {
      follow = true;
      continue;
    }
    if (arg === '-n' || arg === '--lines') {
      const value = rest[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new CliError(`Expected a line count after ${arg}, got: ${value ?? '(nothing)'}`);
      }
      lines = Number(value);
      if (lines < 1 || lines > MAX_LOG_LINES) {
        throw new CliError(`Line count out of range (1-${MAX_LOG_LINES}): ${value}`);
      }
      index += 1;
      continue;
    }
    throw new CliError(`Unknown option for logs: ${arg}`);
  }

  return { follow, lines };
}

// The shared pattern is unflagged for the wire; the `i` here is load-bearing —
// the CLI accepts an uppercase sha off a terminal and lowercases it below.
const CANARY_SHA_PATTERN = new RegExp(UPGRADE_SHA_PATTERN, 'i');
const UPGRADE_VERSION_REGEX = new RegExp(UPGRADE_VERSION_PATTERN);

/**
 * Parse `upgrade`/`update` args: --check, --yes, one of --stable/--canary
 * [sha]/--version <x.y.z>, --rollback, --no-restart, --json.
 * // Usage: parseUpgradeArgs(['--canary', 'abc1234', '--yes'])
 */
export function parseUpgradeArgs(rest: string[]): UpgradeArgs {
  let check = false;
  let yes = false;
  let channel: UpdateChannel | undefined;
  let version: string | undefined;
  let sha: string | undefined;
  let rollback = false;
  let noRestart = false;
  let json = false;
  let channelFlags = 0;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--stable') {
      channel = 'stable';
      channelFlags += 1;
      continue;
    }
    if (arg === '--canary') {
      channel = 'canary';
      channelFlags += 1;
      const next = rest[index + 1];
      if (next !== undefined && CANARY_SHA_PATTERN.test(next)) {
        sha = next.toLowerCase();
        index += 1;
      }
      continue;
    }
    if (arg === '--version') {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CliError('Missing value for upgrade --version.');
      }
      // The engine builds a staging directory name from this value
      // (`.staging-<version>-<pid>`), so it has to look like a version — not
      // a path segment such as `../../x` — before it ever reaches a join.
      if (!UPGRADE_VERSION_REGEX.test(value)) {
        throw new CliError(
          `Invalid value for upgrade --version: ${value} | expected shape: ${UPGRADE_VERSION_PATTERN}`
        );
      }
      // --version names a stable release by definition; the rolling canary
      // has no notion of an exact version to pin without a --canary <sha>.
      channel = 'stable';
      version = value;
      channelFlags += 1;
      index += 1;
      continue;
    }
    if (arg === '--rollback') {
      rollback = true;
      continue;
    }
    if (arg === '--no-restart') {
      noRestart = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new CliError(`Unknown option for upgrade: ${arg}`);
  }

  if (channelFlags > 1) {
    throw new CliError(
      'Choose one of --stable, --canary, or --version for upgrade — they are mutually exclusive.'
    );
  }

  return {
    check,
    yes,
    rollback,
    noRestart,
    json,
    ...(channel !== undefined ? { channel } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(sha !== undefined ? { sha } : {}),
  };
}

/** `env` options that take the next argument as their value, and where it lands. */
const ENV_VALUE_FLAGS = {
  '--environment': 'environmentId',
  '--version': 'version',
  '--user': 'user',
} as const;

type EnvValueFlag = keyof typeof ENV_VALUE_FLAGS;

function isEnvValueFlag(arg: string | undefined): arg is EnvValueFlag {
  return arg !== undefined && arg in ENV_VALUE_FLAGS;
}

/**
 * Parse `env` args: optional subcommand and --json, plus `install`/`update`'s
 * own `<recipe>`, `--environment <id>`, and `--version <spec>`.
 * // Usage: parseEnvArgs(['install', 'bun.install.official'])
 */
export function parseEnvArgs(rest: string[]): EnvArgs {
  let json = false;
  const values: Partial<Record<(typeof ENV_VALUE_FLAGS)[EnvValueFlag], string>> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    const field = isEnvValueFlag(arg) ? ENV_VALUE_FLAGS[arg] : undefined;
    if (field) {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CliError(`Missing value for env ${arg}`);
      }
      values[field] = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('-')) {
      throw new CliError(`Unknown option for env: ${arg}`);
    }
    if (arg !== undefined) positionals.push(arg);
  }

  const { environmentId, version, user } = values;
  const subcommand = positionals[0];
  if (subcommand === undefined) {
    return { subcommand: null, json };
  }
  if (subcommand === 'runtimes' || subcommand === 'agents') {
    if (positionals.length > 1) {
      throw new CliError(`Unexpected extra arguments for env: ${positionals.slice(1).join(' ')}`);
    }
    return { subcommand, json };
  }
  if (subcommand === 'install' || subcommand === 'update') {
    const recipeId = positionals[1];
    if (recipeId === undefined) {
      throw new CliError(
        `Missing recipe id for env ${subcommand}. Usage: env ${subcommand} <recipe> [--environment <id>] [--version <spec>]`
      );
    }
    if (positionals.length > 2) {
      throw new CliError(
        `Unexpected extra arguments for env ${subcommand}: ${positionals.slice(2).join(' ')}`
      );
    }
    return {
      subcommand,
      recipeId,
      json,
      ...(environmentId !== undefined && { environmentId }),
      ...(version !== undefined && { version }),
      ...(user !== undefined && { user }),
    };
  }
  if (subcommand === 'toolchain') {
    return parseEnvToolchainArgs(positionals.slice(1), { json, environmentId, user });
  }
  throw new CliError(`Unknown env subcommand: ${subcommand}`);
}

const TOOLCHAIN_USAGE =
  'Usage: env toolchain [node|bun <path|auto>] [--environment <id>] [--user <email>]';

function parseEnvToolchainArgs(
  positionals: readonly string[],
  flags: { json: boolean; environmentId?: string; user?: string }
): EnvArgs {
  const base: EnvArgs = {
    subcommand: 'toolchain',
    json: flags.json,
    ...(flags.environmentId !== undefined && { environmentId: flags.environmentId }),
    ...(flags.user !== undefined && { user: flags.user }),
  };
  if (positionals.length === 0) return base;
  const [runtime, choice, ...extra] = positionals;
  if (runtime !== 'node' && runtime !== 'bun') {
    throw new CliError(`Unknown toolchain runtime: ${runtime}. ${TOOLCHAIN_USAGE}`);
  }
  if (choice === undefined) {
    throw new CliError(`Missing selection for env toolchain ${runtime}. ${TOOLCHAIN_USAGE}`);
  }
  if (extra.length > 0) {
    throw new CliError(`Unexpected extra arguments for env toolchain: ${extra.join(' ')}`);
  }
  return { ...base, runtime, choice };
}

const LIBRARY_KINDS = new Set<ResourceKind>([
  'skill',
  'subagent',
  'command',
  'instruction',
  'setting',
  'hook',
]);

/** Parse `library` args: optional subcommand, filters, and --json. */
export function parseLibraryArgs(rest: string[]): LibraryArgs {
  let json = false;
  let divergent = false;
  let kind: ResourceKind | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--divergent') {
      divergent = true;
      continue;
    }
    if (arg === '--kind') {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) {
        throw new CliError('Missing value for library --kind');
      }
      if (!LIBRARY_KINDS.has(value as ResourceKind)) {
        throw new CliError(`Unknown library kind: ${value}`);
      }
      kind = value as ResourceKind;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliError(`Unknown option for library: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new CliError(`Unexpected extra arguments for library: ${positionals.slice(1).join(' ')}`);
  }

  const subcommand = positionals[0];
  if (subcommand === undefined) {
    return { subcommand: null, kind, divergent, json };
  }
  if (subcommand === 'locations') {
    return { subcommand: 'locations', kind, divergent, json };
  }
  throw new CliError(`Unknown library subcommand: ${subcommand}`);
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
