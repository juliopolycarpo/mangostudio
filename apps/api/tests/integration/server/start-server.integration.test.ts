import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureHomeEnv } from '../../../../../scripts/lib/temp-home';
import { acquireCaptureLock } from '../../../src/backup/capture-lock';
import {
  createManagedProcessFixture,
  type ManagedProcessFixture,
} from '../../support/fixtures/managed-process';

/**
 * Boots the real server via the hidden `__serve` command in an isolated HOME so
 * the state file and logs land in a temp ~/.mango. Proves the full lifecycle:
 * listen → health 200 → state file written → SIGTERM → clean removal.
 */

const ENTRY = join(import.meta.dir, '../../../src/index.ts');
const START_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;
const VALID_AUTH_SECRET = 'test-secret-at-least-32-characters-long';

/**
 * Environment for the spawned server. It boots the real production server, so
 * NODE_ENV is forced to 'production': inheriting the parent's NODE_ENV=test
 * would trip the in-memory config safety net in src/lib/config.ts and ignore
 * the explicit API_PORT / DATABASE_PATH below.
 */
function serverEnv(
  home: string,
  port: number,
  ambient: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return {
    ...(ambient as Record<string, string>),
    NODE_ENV: 'production',
    ...fixtureHomeEnv(home),
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    MANGOSTUDIO_DEFAULT_API_HOST: '',
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

describe('startServer via __serve', () => {
  it(
    'holds persisted data ownership until the Hub exits',
    async () => {
      const running = await createManagedProcessFixture({ tempPrefix: 'mango-data-ownership-' });
      const database = join(running.tempDir, 'database.sqlite');
      try {
        running.spawn({
          cmd: ['bun', ENTRY, '__serve', String(running.port)],
          env: {
            ...serverEnv(running.tempDir, running.port),
            DATABASE_PATH: database,
            BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
          },
        });
        await running.waitUntilReady(() => probeHealthOnce('127.0.0.1', running.port), {
          label: 'persisted Hub health',
          timeoutMs: START_TIMEOUT_MS,
        });
        await expect(acquireCaptureLock(database)).rejects.toThrow('already in use');
        await running.stop(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
        const release = await acquireCaptureLock(database);
        await release();
      } finally {
        await running.cleanup();
        await running.assertReleased();
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses to start while backup owns the configured database',
    async () => {
      const running = await createManagedProcessFixture({ tempPrefix: 'mango-backup-lock-' });
      const database = join(running.tempDir, 'database.sqlite');
      const release = await acquireCaptureLock(database);
      try {
        running.spawn({
          cmd: ['bun', ENTRY, '__serve', String(running.port)],
          env: {
            ...serverEnv(running.tempDir, running.port),
            DATABASE_PATH: database,
            BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
          },
        });
        expect(await running.waitForExit()).toBe(1);
        expect(running.diagnostics()).toContain('capture lock cannot be acquired');
        expect(await probeHealthOnce('127.0.0.1', running.port)).toBe(false);
      } finally {
        await release();
        await running.cleanup();
        await running.assertReleased();
      }
    },
    TEST_TIMEOUT_MS
  );

  let fixture: ManagedProcessFixture | null = null;

  beforeEach(async () => {
    fixture = await createManagedProcessFixture({ tempPrefix: 'mango-serve-' });
  });

  afterEach(async () => {
    if (!fixture) return;
    await fixture.cleanup();
    await fixture.assertReleased();
    fixture = null;
  });

  /** Starts the server and waits until it is healthy and has written its state file. */
  async function startServing(
    running: ManagedProcessFixture,
    preload?: string,
    ambient: NodeJS.ProcessEnv = process.env
  ): Promise<{ pid: number | undefined; pidFile: string }> {
    const { port, tempDir: home } = running;
    const pidFile = join(home, '.mango', 'run', 'server.json');

    const child = running.spawn({
      cmd: ['bun', ...(preload ? ['--preload', preload] : []), ENTRY, '__serve', String(port)],
      env: {
        ...serverEnv(home, port, ambient),
        BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
      },
    });

    await running.waitUntilReady(() => probeHealthOnce('127.0.0.1', port), {
      label: `server health at 127.0.0.1:${port}`,
      timeoutMs: START_TIMEOUT_MS,
      intervalMs: 150,
    });
    await running.waitUntilReady(() => existsSync(pidFile), {
      label: `server state file ${pidFile}`,
      timeoutMs: START_TIMEOUT_MS,
    });
    return { pid: child.pid, pidFile };
  }

  it(
    'listens, serves health, and writes its state',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');

      const { pid, pidFile } = await startServing(fixture);

      const state = JSON.parse(await readFile(pidFile, 'utf8'));
      expect(state.pid).toBe(pid);
      expect(state.port).toBe(fixture.port);
      expect(state.host).toBe('127.0.0.1');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'keeps inherited state roots private in the managed server child',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const external = await mkdtemp(join(tmpdir(), 'mango-serve-external-'));
      const keys = [
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'XDG_RUNTIME_DIR',
        'XDG_CONFIG_DIRS',
        'XDG_DATA_DIRS',
        'APPDATA',
        'LOCALAPPDATA',
      ];
      const preload = join(fixture.tempDir, 'state-root-probe.ts');
      const reportFile = join(fixture.tempDir, 'state-roots.json');
      try {
        await writeFile(
          preload,
          `
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const roots = Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]));
        for (const [key, root] of Object.entries(roots)) {
          mkdirSync(join(root, 'fixture'), { recursive: true });
          writeFileSync(join(root, 'fixture', key), 'private fixture state');
        }
        writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(roots));
      `
        );
        const ambient = { ...process.env };
        for (const key of keys) ambient[key] = external;
        await startServing(fixture, preload, ambient);
        const roots = JSON.parse(await readFile(reportFile, 'utf8'));
        for (const key of keys) {
          const path = relative(fixture.tempDir, roots[key]);
          expect(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path), key).toBe(false);
        }
        expect(await readdir(external)).toEqual([]);
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  it.each([
    {
      label: 'unconfigured foreground serve',
      target: undefined,
      envHost: undefined,
      expected: 'localhost',
    },
    {
      label: 'foreground CLI host over API_HOST',
      target: '127.0.0.1',
      envHost: '0.0.0.0',
      expected: '127.0.0.1',
    },
  ])(
    '$label binds the expected interface',
    async (entry) => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const { port, tempDir: home } = fixture;
      const pidFile = join(home, '.mango', 'run', 'server.json');
      const target = entry.target ? `${entry.target}:${port}` : String(port);
      fixture.spawn({
        cmd: ['bun', ENTRY, 'serve', target],
        env: {
          ...serverEnv(home, port),
          API_HOST: entry.envHost,
          BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
        },
      });
      await fixture.waitUntilReady(() => probeHealthOnce(entry.expected, port), {
        label: `server health at ${entry.expected}:${port}`,
        timeoutMs: START_TIMEOUT_MS,
      });
      await waitForState(pidFile);
      const state = JSON.parse(await readFile(pidFile, 'utf8'));
      expect(state.host).toBe(entry.expected);
      expect(state.port).toBe(port);
    },
    TEST_TIMEOUT_MS
  );

  // Windows has no SIGTERM: a kill there terminates the process, so no handler runs.
  it.skipIf(process.platform === 'win32')(
    'exits cleanly and removes its state on SIGTERM',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const { pidFile } = await startServing(fixture);

      const exitCode = await fixture.stop('SIGTERM');

      expect(exitCode).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it.skipIf(process.platform === 'win32')(
    'removes its state and exits cleanly when runtime teardown fails',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const preload = fileURLToPath(
        new URL('../../support/fixtures/failing-runtime-shutdown.ts', import.meta.url)
      );
      const { pidFile } = await startServing(fixture, preload);

      expect(await fixture.stop('SIGTERM')).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(fixture.diagnostics()).toContain('fixture runtime teardown failed');
      expect(fixture.diagnostics()).toContain('Runtime connection teardown failed during shutdown');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits before listening when the auth secret is missing',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const { port, tempDir: home } = fixture;

      fixture.spawn({
        cmd: ['bun', ENTRY, '__serve', String(port)],
        env: {
          ...serverEnv(home, port),
          BETTER_AUTH_SECRET: '   ',
        },
      });

      const exitCode = await fixture.waitForExit();

      expect(exitCode).toBe(1);
      expect(fixture.diagnostics()).toContain('BETTER_AUTH_SECRET is required');
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
