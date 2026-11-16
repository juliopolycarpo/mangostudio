/**
 * Starting a compiled hub the way the benchmarks and the build's AOT order recording need it: a
 * throwaway home, a loopback port the OS chose, and a fixed auth secret, so nothing reads or writes
 * the developer's own `~/.mango`.
 */

import { createServer } from 'node:net';
import { join } from 'node:path';

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
 * The environment an isolated hub runs in: the caller's own, with every home, config, data, cache
 * and storage location moved into `home`.
 * Example: isolatedHubEnv('/tmp/mangostudio-hub-run-a1b2c3', 3001)
 */
export function isolatedHubEnv(home: string, port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
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
