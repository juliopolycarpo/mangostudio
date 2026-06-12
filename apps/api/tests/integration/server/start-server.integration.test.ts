import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boots the real server via the hidden `__serve` command in an isolated HOME so
 * the state file and logs land in a temp ~/.mango. Proves the full lifecycle:
 * listen → health 200 → state file written → SIGTERM → clean removal.
 */

const ENTRY = join(import.meta.dir, '../../../src/index.ts');
const START_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;
const VALID_AUTH_SECRET = 'test-secret-at-least-32-characters-long';

/** Reserve a free TCP port by briefly binding to port 0. */
async function reserveFreePort(): Promise<number> {
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
    throw new Error('failed to reserve a free port');
  }
  return address.port;
}

/**
 * Environment for the spawned server. It boots the real production server, so
 * NODE_ENV is forced to 'production': inheriting the parent's NODE_ENV=test
 * would trip the in-memory config safety net in src/lib/config.ts and ignore
 * the explicit API_PORT / DATABASE_PATH below.
 */
function serverEnv(home: string, port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'production',
    HOME: home,
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    DATABASE_PATH: ':memory:',
    MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function probeHealthOnce(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(host: string, port: number): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealthOnce(host, port)) {
      return;
    }
    await sleep(150);
  }
  const url = `http://${host}:${port}/api/health`;
  throw new Error(`server health check did not pass at ${url} within ${START_TIMEOUT_MS}ms`);
}

/**
 * Wait for the single-instance state file to appear. Health is reachable the
 * instant the server listens, but persistState writes the file a beat later, so
 * polling here avoids a read race after waitForHealth.
 */
async function waitForState(pidFile: string, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`server state file was not created at ${pidFile} within ${timeoutMs}ms`);
}

async function waitForServerReady(host: string, port: number, pidFile: string): Promise<void> {
  await waitForHealth(host, port);
  await waitForState(pidFile);
}

async function waitForExit(child: Bun.Subprocess): Promise<number> {
  const timedOut = Symbol('timedOut');
  const result = await Promise.race([child.exited, sleep(5000).then(() => timedOut)]);
  if (typeof result !== 'number') {
    throw new Error('child process did not exit in time');
  }
  return result;
}

function readStderr(child: Bun.Subprocess): Promise<string> {
  if (!child.stderr || typeof child.stderr === 'number') {
    return Promise.resolve('');
  }
  return Bun.readableStreamToText(child.stderr);
}

describe('startServer via __serve', () => {
  let home = '';
  let child: Bun.Subprocess | null = null;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mango-serve-'));
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
    child = null;
    await rm(home, { force: true, recursive: true });
  });

  it(
    'listens, writes state, serves health, and cleans up on SIGTERM',
    async () => {
      const port = await reserveFreePort();
      const pidFile = join(home, '.mango', 'run', 'server.json');

      child = Bun.spawn({
        cmd: ['bun', ENTRY, '__serve', String(port)],
        env: {
          ...serverEnv(home, port),
          BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });

      await waitForServerReady('127.0.0.1', port, pidFile);

      const state = JSON.parse(await readFile(pidFile, 'utf8'));
      expect(state.pid).toBe(child.pid);
      expect(state.port).toBe(port);
      expect(state.host).toBe('127.0.0.1');

      child.kill('SIGTERM');
      const exitCode = await waitForExit(child);

      expect(exitCode).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits before listening when the auth secret is missing',
    async () => {
      const port = await reserveFreePort();

      child = Bun.spawn({
        cmd: ['bun', ENTRY, '__serve', String(port)],
        env: {
          ...serverEnv(home, port),
          BETTER_AUTH_SECRET: '   ',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });

      const stderr = readStderr(child);
      const exitCode = await waitForExit(child);

      expect(exitCode).toBe(1);
      expect(await stderr).toContain('BETTER_AUTH_SECRET is required');
      expect(await probeHealthOnce('127.0.0.1', port)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});

describe('waitForState', () => {
  it('waits for delayed state file creation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-state-wait-'));
    const pidFile = join(dir, 'server.json');

    try {
      setTimeout(() => void writeFile(pidFile, '{}'), 25);
      await waitForState(pidFile, 500);
      expect(existsSync(pidFile)).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('reports the missing state file path on timeout', async () => {
    const pidFile = join(tmpdir(), `missing-server-${crypto.randomUUID()}.json`);

    await expect(waitForState(pidFile, 25)).rejects.toThrow(
      `server state file was not created at ${pidFile} within 25ms`
    );
  });
});
