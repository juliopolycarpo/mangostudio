/**
 * Starting a compiled hub the way the benchmarks and the build's AOT order recording need it: a
 * throwaway home, a loopback port the OS chose, and a fixed auth secret, so nothing reads or writes
 * the developer's own `~/.mango`.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { ChildSupervisor, processHost } from './process-tree';
import {
  createTemporaryHome,
  fixtureHomeEnv,
  removeTemporaryHome,
  type TemporaryHomeKind,
} from './temp-home';

const ISOLATED_HUB_AUTH_SECRET = 'isolated-hub-secret-at-least-32-chars';

/** The temporary-home shape an isolated hub run lives in; deletion is refused for any other path. */
const ISOLATED_HUB_HOME: TemporaryHomeKind = {
  prefix: 'mangostudio-hub-run-',
  context: 'isolated hub',
  noun: 'hub run home',
};

/** Creates the throwaway home one isolated hub run lives in. Example: createIsolatedHubHome() // '/tmp/mangostudio-hub-run-a1b2c3' */
export function createIsolatedHubHome(): string {
  return createTemporaryHome(ISOLATED_HUB_HOME);
}

/** Deletes a home from `createIsolatedHubHome`, after proving that is what it is. Example: removeIsolatedHubHome(home) */
export function removeIsolatedHubHome(home: string): void {
  removeTemporaryHome(home, ISOLATED_HUB_HOME);
}

/**
 * The variables an isolated hub may take from the caller: where programs are found, the locale and
 * time zone, the temp directory, and the few a process needs to start on Windows. Everything else
 * is dropped. The hub is a server with open sign-up and a fixed auth secret, started by a build
 * that holds release credentials, so it must not see `GITHUB_TOKEN`, provider API keys, proxy
 * settings, a runtime override (`MANGOSTUDIO_RUNTIME_BINARY`), another URL or origin
 * (`PUBLIC_URL`, `ALLOWED_ORIGINS`) or the session bus (`DBUS_SESSION_BUS_ADDRESS`).
 */
const INHERITED_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

/** `LC_ALL`, `LC_CTYPE`, ... Example: isInheritedHubEnvName('LC_ALL') // true */
function isInheritedHubEnvName(name: string): boolean {
  return INHERITED_ENV_NAMES.has(name) || name.startsWith('LC_');
}

/**
 * The environment an isolated hub runs in: an allowlist of the caller's own (see
 * `INHERITED_ENV_NAMES`), with every home, config, data, cache and storage location moved into
 * `home`, and the update check off so the hub makes no network request of its own.
 * Example: isolatedHubEnv('/tmp/mangostudio-hub-run-a1b2c3', 3001, { PATH: '/usr/bin' })
 */
export function isolatedHubEnv(
  home: string,
  port: number,
  ambient: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value !== undefined && isInheritedHubEnvName(name)) inherited[name] = value;
  }
  return {
    ...inherited,
    ...fixtureHomeEnv(home),
    NODE_ENV: 'production',
    MANGO_HOME: home,
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    AUTH_SECRET: ISOLATED_HUB_AUTH_SECRET,
    BETTER_AUTH_SECRET: ISOLATED_HUB_AUTH_SECRET,
    DATABASE_PATH: join(home, 'database.sqlite'),
    UPLOADS_DIR: join(home, 'uploads'),
    IMAGES_DIR: join(home, 'images'),
    TOOL_IMAGES_DIR: join(home, 'tool-images'),
    MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
    // The checker fires a few seconds after start and would reach the network from a build.
    MANGO_UPDATES_CHECK: '0',
  };
}

/** What a hub that owns an isolated home writes to `<home>/.mango/run/server.json`. */
const SERVER_STATE_PATH = join('.mango', 'run', 'server.json');

/**
 * Whether a parsed `server.json` belongs to the hub this process spawned: its pid and port, written
 * after `spawnedAt`. A health answer alone does not prove it: between the port being chosen and the
 * hub binding it, another process can take the port.
 * Example: ownsStartupState({ pid: 42, port: 3001, startedAt: 100 }, 42, 3001, 99) // true
 */
export function ownsStartupState(
  state: unknown,
  pid: number,
  port: number,
  spawnedAt: number
): boolean {
  if (!state || typeof state !== 'object') return false;
  const value = state as Record<string, unknown>;
  return (
    value.pid === pid &&
    value.port === port &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    value.startedAt >= spawnedAt
  );
}

/** True once `home` holds the state file of the hub this process spawned. Example: await ownsServerState(home, pid, port, spawnedAt) */
export async function ownsServerState(
  home: string,
  pid: number,
  port: number,
  spawnedAt: number
): Promise<boolean> {
  try {
    return ownsStartupState(
      JSON.parse(await readFile(join(home, SERVER_STATE_PATH), 'utf8')),
      pid,
      port,
      spawnedAt
    );
  } catch {
    return false;
  }
}

let hubSupervisor: ChildSupervisor | undefined;

/**
 * Ties an isolated hub's life to this process. A hub runs detached in its own process group, so a
 * Ctrl-C or a runner cancelling its group stops this process and leaves the hub listening on
 * loopback with its home on disk. While guarded, SIGINT, SIGTERM and SIGHUP stop the hub's whole
 * group (SIGKILL after a grace period) before this process exits, and the home is deleted on exit.
 * The returned function ends the guard; call it once the hub is gone.
 * Example: const release = guardIsolatedHub(child, home, 'recording hub'); try { ... } finally { release(); }
 */
export function guardIsolatedHub(
  child: {
    readonly pid: number;
    readonly exited: Promise<unknown>;
    kill(signal?: NodeJS.Signals): void;
  },
  home: string,
  label: string
): () => void {
  hubSupervisor ??= new ChildSupervisor(processHost());
  const release = hubSupervisor.adopt({
    label,
    pid: child.pid,
    ownsGroup: process.platform !== 'win32',
    exited: child.exited,
    signal: (signal) => child.kill(signal),
  });
  const removeHome = (): void => {
    try {
      removeIsolatedHubHome(home);
    } catch {
      // Best effort while the process is exiting.
    }
  };
  process.on('exit', removeHome);
  return () => {
    process.off('exit', removeHome);
    release();
  };
}

/** An unused loopback port chosen by the OS. Example: await reserveEphemeralPort(). */
export async function reserveEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('port: expected an OS-selected loopback port | received: no TCP address');
  }
  return address.port;
}
