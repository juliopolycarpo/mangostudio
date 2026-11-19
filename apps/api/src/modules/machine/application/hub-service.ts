/**
 * The hub's own service unit: how it is built and the manager that installs
 * it. The CLI `service` command and the machine API both come through here.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createUserServiceManager,
  RestartRetargetedError,
  type UserServiceDefinition,
  type UserServiceExecDeps,
  type UserServiceManager,
} from '@mangostudio/shared/machine/service';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';

import {
  getConfig,
  getConfigEnvFilePath,
  getVersion,
  type MangoConfig,
  RUNTIME_CONFIG_ENV_KEYS,
} from '../../../lib/config';
import { getLogsDir, getRunDir } from '../../../lib/mango-paths';
import { isStandaloneExecutable } from '../../../lib/runtime-paths';
import { readTomlDocument } from '../../../lib/toml';
import {
  detectInstallOrigin,
  type InstallOriginProbe,
  launcherForVersionedPath,
  restartLauncher,
} from '../../updates/domain/install-origin';
import {
  type HubExecutable,
  type HubExecutableProbe,
  resolveHubExecutable,
} from '../domain/hub-executable';
import { HUB_SERVICE_IDENTITY, HUB_SERVICE_UNIT_ENV } from '../domain/hub-service-identity';

/**
 * Configuration this hub may hold in its environment that a unit must still not
 * carry. A unit file is read back by anything that can read the file, and the
 * auth secret does not belong in one — `service install` already refuses while
 * it lives nowhere else (`secret-not-persisted`), which is the answer for it.
 */
const SERVICE_ENV_SECRETS = new Set(['BETTER_AUTH_SECRET']);

/**
 * Environment the unit carries. A unit file is readable by every process of
 * this user, so this is a positive list of configuration only: connector
 * secrets and the auth secret load from `~/.mango/.env` at startup, exactly as
 * they do for a detached start.
 */
const SERVICE_ENV_ALLOWLIST: readonly string[] = [
  // Runtime configuration, including image defaults, comes from config.ts so
  // new keys reach a unit the way they reach a detached child (see
  // `DETACH_ENV_ALLOWLIST`). Dropping these silently reconfigured the hub on
  // handover: an operator who exports `DATABASE_PATH` and runs `serve` would
  // install a unit that starts on defaults, and watch their chats disappear
  // behind a fresh database.
  ...RUNTIME_CONFIG_ENV_KEYS.filter((key) => !SERVICE_ENV_SECRETS.has(key)),
  // Read straight from `process.env` rather than through `ENV_KEY_MAP`, and
  // carried for the same reason `DETACH_ENV_ALLOWLIST` carries them: a unit
  // that dropped them would report version `dev` next to a checkout that
  // reports otherwise (a doctor build-identity failure), and would turn
  // diagnostic logging off the moment the hub handed over.
  'VERSION',
  'MANGOSTUDIO_DIAGNOSTIC_LOGS',
  // getRuntimeBinaryOverride (config.ts) reads this directly from
  // process.env on every stdio launch, exactly as DETACH_ENV_ALLOWLIST's own
  // comment describes for a detached child — an operator who exports it
  // before `service install` means the installed unit to honor it too, not
  // silently fall back to the sibling binary or Bun the moment the hub hands
  // over to the service manager.
  'MANGOSTUDIO_RUNTIME_BINARY',
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

/**
 * The bind target a unit must carry, given the instance it is about to
 * replace. None when that instance sits where `config.toml` already points, so
 * a later edit there still moves the unit. Otherwise the predecessor's own
 * address, because the hand-over stops it: `serve -d lan:4000` followed by an
 * install would otherwise bind the defaults and take neither.
 * // Usage: hubServiceTargetFor(predecessor, { host, port })
 */
export function hubServiceTargetFor(
  predecessor: { readonly host: string; readonly port: number } | null,
  configured: { readonly host: string; readonly port: number }
): HubServiceTarget | undefined {
  if (!predecessor) return undefined;
  if (predecessor.host === configured.host && predecessor.port === configured.port) {
    return undefined;
  }
  return { host: predecessor.host, port: predecessor.port };
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

/** The file a path really names, or the path itself when it cannot be resolved. // Usage: realPathOrSelf('~/.mango/config.toml') */
export function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The launcher a restart may come back through for this install, when there is
 * one. The version directory this process runs from is the manager's to
 * replace, so re-execing that path after a delegated upgrade starts the build
 * that was just replaced; `restartLauncher` names the path that follows the
 * manager's upgrade instead. Undefined for a self-managed install, which the
 * `current` pointer covers, and for npm and bun, whose own path already does.
 * // Usage: restartExecutableOptions(currentHubExecutable(), currentLauncherPath())
 */
export function currentLauncherPath(): string | undefined {
  const probe = currentInstallOriginProbe();
  return restartLauncher(detectInstallOrigin(probe), {
    platform: probe.platform,
    execPath: probe.execPath,
    pathExists: currentHubExecutableProbe().pathExists,
  });
}

export interface StaleUnitProbe {
  readonly platform: NodeJS.Platform;
  readonly pathExists: (path: string) => boolean;
}

/** A unit's recorded program and the launcher it should run instead. */
export interface RetargetedUnit {
  readonly from: string;
  readonly to: string;
}

/**
 * The move a unit written before it named the manager's launcher needs, or
 * null when it needs none. Such a unit records the versioned path the install
 * had when `service install` ran (Homebrew's Cellar entry, pnpm's `.pnpm`
 * directory, Scoop's version directory), so a restart after an upgrade starts
 * the replaced build, or fails once the manager removed that directory. Only a
 * unit whose program is a versioned path of the same layout as `launcherPath`
 * qualifies; one the operator pointed somewhere else does not. Reads the unit,
 * changes nothing.
 * // Usage: const stale = await staleHubServiceMove(manager, currentLauncherPath())
 */
export async function staleHubServiceMove(
  manager: UserServiceManager,
  launcherPath: string | undefined,
  probe: StaleUnitProbe = {
    platform: process.platform,
    pathExists: currentHubExecutableProbe().pathExists,
  }
): Promise<RetargetedUnit | null> {
  if (!launcherPath) return null;
  const { installed, execPath } = await manager.status();
  if (!installed || !execPath) return null;
  const sameFile = (a: string, b: string): boolean =>
    probe.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (sameFile(execPath, launcherPath)) return null;
  const owner = launcherForVersionedPath(execPath, probe);
  if (owner === undefined || !sameFile(owner, launcherPath)) return null;
  return { from: execPath, to: launcherPath };
}

export interface RestartHubServiceOptions {
  /** Bring up a stopped unit instead of bouncing a running one. */
  readonly start?: boolean;
  readonly probe?: StaleUnitProbe;
  /** Where the warning for a failed move goes; defaults to stderr. */
  readonly warn?: (message: string) => void;
}

/**
 * Bring the hub's unit up, first moving a stale one onto the launcher as part
 * of the same supervisor operation (see `UserServiceManager.restartRetargeted`).
 * The move is a repair, not the point of the call: when the rewrite fails the
 * unit is brought up as installed after a warning that names the stale path and
 * the command that rewrites the unit, so an upgrade or a restart never ends
 * with the hub down because a unit file could not be rewritten.
 *
 * A failure after the rewrite is a different thing: the unit is already moved
 * and its restart failed, so a second restart as installed would only meet the
 * same refusal. That error is thrown as it is, saying the unit was updated.
 * Returns the move it made, if any.
 * // Usage: const moved = await restartHubService(manager, currentLauncherPath())
 */
export async function restartHubService(
  manager: UserServiceManager,
  launcherPath: string | undefined,
  options: RestartHubServiceOptions = {}
): Promise<RetargetedUnit | null> {
  const stale = await staleHubServiceMove(manager, launcherPath, options.probe);
  if (stale) {
    try {
      await manager.restartRetargeted(stale.to);
      return stale;
    } catch (error) {
      if (error instanceof RestartRetargetedError && error.phase === 'restart') throw error;
      const reason =
        error instanceof RestartRetargetedError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error);
      (options.warn ?? ((message) => process.stderr.write(`mangostudio: ${message}\n`)))(
        `Could not move the service unit off ${stale.from} onto ${stale.to} (${reason}); starting it as installed. Run "mangostudio service install" to repair the unit.`
      );
    }
  }
  await (options.start ? manager.start() : manager.restart());
  return null;
}

/**
 * The install-origin probe for this process, sharing the platform/execPath/
 * home/localAppData facts {@link currentHubExecutableProbe} already gathers —
 * `detectInstallOrigin` and `resolveHubExecutable` answer different questions
 * about the same binary, and re-deriving those facts a second way would risk
 * the two disagreeing about where this process actually runs from.
 */
export function currentInstallOriginProbe(
  overrides: Partial<InstallOriginProbe> = {}
): InstallOriginProbe {
  const base = currentHubExecutableProbe();
  return {
    platform: base.platform,
    env: process.env,
    execPath: base.execPath,
    version: getVersion(),
    standalone: base.standalone,
    container: getConfig().environments.container,
    home: base.home,
    localAppData: base.localAppData,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    ...overrides,
  };
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
  if (!tomlPath) return false;
  try {
    // Resolve first: `config.toml` is one of the files users symlink into a
    // dotfiles repo (#617), which `loadConfig` follows via `readFileSync` and
    // `writeFileAtomic` writes through. `readTomlDocument` opens with
    // `O_NOFOLLOW`, so reading the link itself raises `ELOOP` and this gate
    // would refuse a hub that boots with the secret just fine. A missing file
    // still reads as an empty document, so there is no exists-then-read window
    // in which a throw is mistaken for "no secret persisted".
    const auth = readTomlDocument(realPathOrSelf(tomlPath)).auth as
      Record<string, unknown> | undefined;
    return typeof auth?.secret === 'string' && auth.secret.trim().length > 0;
  } catch {
    // Malformed TOML still throws out of the parser.
    return false;
  }
}

/**
 * The manager for the hub's unit. The launchd retarget helper's plist lives in
 * the hub's run directory, not in LaunchAgents, so a leftover never runs at login.
 * // Usage: createHubServiceManager().status()
 */
export function createHubServiceManager(deps?: UserServiceExecDeps): UserServiceManager {
  return createUserServiceManager(HUB_SERVICE_IDENTITY, deps, { retargetHelperDir: getRunDir() });
}
