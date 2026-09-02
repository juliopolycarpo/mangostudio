/**
 * The hub's own service unit: how it is built and the manager that installs
 * it. The CLI `service` command and the machine API both come through here.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createUserServiceManager,
  type UserServiceDefinition,
  type UserServiceExecDeps,
  type UserServiceManager,
} from '@mangostudio/runtime';
import { getLogsDir } from '../../../lib/mango-paths';
import { isStandaloneExecutable } from '../../../lib/runtime-paths';
import {
  type HubExecutable,
  type HubExecutableProbe,
  resolveHubExecutable,
} from '../domain/hub-executable';
import { HUB_SERVICE_IDENTITY, HUB_SERVICE_UNIT_ENV } from '../domain/hub-service-identity';

/**
 * Environment the unit carries. A unit file is readable by every process of
 * this user, so this is a positive list of configuration only: connector
 * secrets and the auth secret load from `~/.mango/.env` at startup, exactly as
 * they do for a detached start.
 */
const SERVICE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'MANGO_HOME',
  'TZ',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

export interface HubServiceTarget {
  readonly host?: string;
  readonly port?: number;
}

export interface HubServiceDefinitionInput {
  readonly executable: HubExecutable;
  readonly unitName: string;
  readonly logFile: string;
  readonly env: NodeJS.ProcessEnv;
  /** Explicit bind target; omitted so `config.toml` keeps deciding. */
  readonly target?: HubServiceTarget;
}

/** Where the supervisor appends the hub's output. */
export function hubServiceLogPath(): string {
  return join(getLogsDir(), 'service.log');
}

/** Build the unit definition. // Usage: buildHubServiceDefinition({ executable, unitName, logFile, env }) */
export function buildHubServiceDefinition(input: HubServiceDefinitionInput): UserServiceDefinition {
  const env: Record<string, string> = {};
  for (const key of SERVICE_ENV_ALLOWLIST) {
    const value = input.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  if (input.target?.host !== undefined) env.API_HOST = input.target.host;
  if (input.target?.port !== undefined) env.API_PORT = String(input.target.port);
  env.MANGO_LOG_FILE = input.logFile;
  env[HUB_SERVICE_UNIT_ENV] = input.unitName;

  return {
    description: 'MangoStudio hub',
    argv: [...input.executable.argv, 'serve'],
    ...(input.executable.workingDirectory
      ? { workingDirectory: input.executable.workingDirectory }
      : {}),
    env,
    logFile: input.logFile,
  };
}

/** The executable probe for this process. */
export function currentHubExecutableProbe(
  overrides: Partial<HubExecutableProbe> = {}
): HubExecutableProbe {
  return {
    platform: process.platform,
    standalone: isStandaloneExecutable(),
    execPath: realPathOrSelf(process.execPath),
    entryPath: Bun.main,
    cwd: process.cwd(),
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    pathExists: (path) => {
      try {
        realpathSync(path);
        return true;
      } catch {
        return false;
      }
    },
    ...overrides,
  };
}

/** What a unit installed right now would run. */
export function currentHubExecutable(overrides: Partial<HubExecutableProbe> = {}): HubExecutable {
  return resolveHubExecutable(currentHubExecutableProbe(overrides));
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The manager for the hub's unit. // Usage: createHubServiceManager().status() */
export function createHubServiceManager(deps?: UserServiceExecDeps): UserServiceManager {
  return createUserServiceManager(HUB_SERVICE_IDENTITY, deps);
}
