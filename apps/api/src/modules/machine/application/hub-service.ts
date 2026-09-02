/**
 * The hub's own service unit: how it is built and the manager that installs
 * it. The CLI `service` command and the machine API both come through here.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createUserServiceManager,
  type UserServiceDefinition,
  type UserServiceExecDeps,
  type UserServiceManager,
} from '@mangostudio/runtime';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';
import { parse as parseToml } from 'smol-toml';
import { getConfig, getConfigEnvFilePath, type MangoConfig } from '../../../lib/config';
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

const PROXY_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]);

/**
 * A proxy URL may carry `user:password@`; that is a secret, and the unit
 * file is not where it goes. The host and port still reach the unit.
 * // Usage: withoutUserinfo('http://alice:pw@proxy:3128') → 'http://proxy:3128/'
 */
export function withoutUserinfo(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

export interface HubServiceTarget {
  readonly host?: string;
  readonly port?: number;
}

export interface HubServiceDefinitionInput {
  readonly executable: HubExecutable;
  readonly unitName: string;
  readonly logFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
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
    // A Scheduled Task inherits the user's PATH at logon, and inlining it
    // there would count against the command-line limit twice over.
    if (key === 'PATH' && input.platform === 'win32') continue;
    const value = input.env[key];
    if (value === undefined || value === '') continue;
    env[key] = PROXY_KEYS.has(key) ? withoutUserinfo(value) : value;
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

/**
 * Whether the auth secret is stored in `~/.mango/.env` or `config.toml`, where
 * a unit started without this shell's environment can load it. `serve` in a
 * terminal generates and stores one on first run; a secret exported only in
 * the shell would leave the unit refusing to start.
 * // Usage: isAuthSecretPersisted()
 */
export function isAuthSecretPersisted(config: MangoConfig = getConfig()): boolean {
  const envFile = parseRuntimeEnvFile(getConfigEnvFilePath(config.configFilePath));
  if (envFile.BETTER_AUTH_SECRET?.trim()) return true;
  const tomlPath = config.configFilePath;
  if (!tomlPath || !existsSync(tomlPath)) return false;
  try {
    const parsed = parseToml(readFileSync(tomlPath, 'utf8')) as Record<string, unknown>;
    const auth = parsed.auth as Record<string, unknown> | undefined;
    return typeof auth?.secret === 'string' && auth.secret.trim().length > 0;
  } catch {
    return false;
  }
}

/** The manager for the hub's unit. // Usage: createHubServiceManager().status() */
export function createHubServiceManager(deps?: UserServiceExecDeps): UserServiceManager {
  return createUserServiceManager(HUB_SERVICE_IDENTITY, deps);
}
