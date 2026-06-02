import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boots the real server via the hidden `__serve` command in an isolated HOME so
 * the state file and logs land in a temp ~/.mango. Proves the full lifecycle:
 * listen → health 200 → state file written → SIGTERM → clean removal.
 */

const ENTRY = join(import.meta.dir, '../../../src/index.ts');
const START_TIMEOUT_MS = 15_000;
const VALID_AUTH_SECRET = 'test-secret-at-least-32-characters-long';

/** Reserve a free TCP port by briefly binding to port 0. */
function reserveFreePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const { port } = server;
  server.stop(true);
  if (typeof port !== 'number') {
    throw new Error('failed to reserve a free port');
  }
  return port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(host: string, port: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Not up yet — keep polling.
    }
    await sleep(150);
  }
  return false;
}

/**
 * Wait for the single-instance state file to appear. Health is reachable the
 * instant the server listens, but persistState writes the file a beat later, so
 * polling here avoids a read race after waitForHealth.
 */
async function waitForState(pidFile: string): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

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

async function waitForExit(child: Bun.Subprocess): Promise<void> {
  const timedOut = Symbol('timedOut');
  const result = await Promise.race([child.exited, sleep(5000).then(() => timedOut)]);
  if (result === timedOut) {
    throw new Error('child process did not exit in time');
  }
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

  it('listens, writes state, serves health, and cleans up on SIGTERM', async () => {
    const port = reserveFreePort();
    const pidFile = join(home, '.mango', 'run', 'server.json');

    child = Bun.spawn({
      cmd: ['bun', ENTRY, '__serve', String(port)],
      env: {
        ...process.env,
        HOME: home,
        API_PORT: String(port),
        API_HOST: '127.0.0.1',
        DATABASE_PATH: ':memory:',
        BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
        MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    expect(await waitForHealth('127.0.0.1', port)).toBe(true);
    expect(await waitForState(pidFile)).toBe(true);

    const state = JSON.parse(await readFile(pidFile, 'utf8'));
    expect(state.pid).toBe(child.pid);
    expect(state.port).toBe(port);
    expect(state.host).toBe('127.0.0.1');

    child.kill('SIGTERM');
    await waitForExit(child);

    expect(child.exitCode).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
  }, 15_000);

  it('exits before listening when the auth secret is missing', async () => {
    const port = reserveFreePort();

    child = Bun.spawn({
      cmd: ['bun', ENTRY, '__serve', String(port)],
      env: {
        ...process.env,
        HOME: home,
        API_PORT: String(port),
        API_HOST: '127.0.0.1',
        DATABASE_PATH: ':memory:',
        BETTER_AUTH_SECRET: '   ',
        MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });

    const stderr = readStderr(child);
    await waitForExit(child);

    expect(child.exitCode).toBe(1);
    expect(await stderr).toContain('BETTER_AUTH_SECRET is required');
    expect(await probeHealthOnce('127.0.0.1', port)).toBe(false);
  }, 15_000);
});
