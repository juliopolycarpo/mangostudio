import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  it.skipIf(process.platform === 'win32')(
    'uses the held physical lock before creating a database through a parent alias',
    async () => {
      const running = await createManagedProcessFixture({ tempPrefix: 'mango-first-db-alias-' });
      const lexicalParent = join(running.tempDir, 'lexical');
      const physicalParent = join(running.tempDir, 'physical');
      const database = join(physicalParent, 'database.sqlite');
      const alias = `${lexicalParent}/link/../database.sqlite`;
      await mkdir(lexicalParent);
      await mkdir(join(physicalParent, 'child'), { recursive: true });
      await symlink(join(physicalParent, 'child'), join(lexicalParent, 'link'), 'dir');
      const release = await acquireCaptureLock(database);
      try {
        const child = running.spawn({
          cmd: ['bun', ENTRY, '__serve', String(running.port)],
          env: {
            ...serverEnv(running.tempDir, running.port),
            DATABASE_PATH: alias,
            BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
          },
        });
        await running.waitUntilReady(
          async () => child.exitCode !== null || (await probeHealthOnce('127.0.0.1', running.port)),
          {
            label: 'Hub exit or successful listen for aliased database',
            timeoutMs: START_TIMEOUT_MS,
          }
        );
        expect(child.exitCode).toBe(1);
        await running.waitForExit();
        expect(running.diagnostics()).toContain('capture lock cannot be acquired');
        expect(existsSync(database)).toBe(false);
        expect(existsSync(join(lexicalParent, 'database.sqlite'))).toBe(false);
      } finally {
        await release();
        await running.cleanup();
        await running.assertReleased();
      }
    },
    TEST_TIMEOUT_MS
  );

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
    'leaves the uploads root absent when backup owns the configured database',
    async () => {
      const running = await createManagedProcessFixture({ tempPrefix: 'mango-backup-lock-' });
      const database = join(running.tempDir, 'database.sqlite');
      const uploads = join(running.tempDir, 'absent', 'uploads');
      const release = await acquireCaptureLock(database);
      try {
        running.spawn({
          cmd: ['bun', ENTRY, '__serve', String(running.port)],
          env: {
            ...serverEnv(running.tempDir, running.port),
            DATABASE_PATH: database,
            UPLOADS_DIR: uploads,
            BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
          },
        });
        expect(await running.waitForExit()).toBe(1);
        expect(running.diagnostics()).toContain('capture lock cannot be acquired');
        expect(await probeHealthOnce('127.0.0.1', running.port)).toBe(false);
        expect(existsSync(uploads)).toBe(false);
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
    {
      ambient = process.env,
      databasePath = ':memory:',
    }: {
      ambient?: NodeJS.ProcessEnv;
      databasePath?: string;
    } = {}
  ): Promise<{ pid: number | undefined; pidFile: string }> {
    const { port, tempDir: home } = running;
    const pidFile = join(home, '.mango', 'run', 'server.json');

    const child = running.spawn({
      cmd: ['bun', ...(preload ? ['--preload', preload] : []), ENTRY, '__serve', String(port)],
      env: {
        ...serverEnv(home, port, ambient),
        DATABASE_PATH: databasePath,
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
        await startServing(fixture, preload, { ambient });
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
    'cleans sessions, terminals and runtimes before awaiting active HTTP drain',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const preload = fileURLToPath(
        new URL('../../support/fixtures/shutdown-dependent-stream.ts', import.meta.url)
      );
      const { pid, pidFile } = await startServing(fixture, preload);
      if (!pid) throw new Error('Expected the fixture server PID.');
      const response = await fetch(`http://127.0.0.1:${fixture.port}/__shutdown-stream`);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected a live shutdown-dependent response body.');
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('stream-ready');
      const socket = new WebSocket(`ws://127.0.0.1:${fixture.port}/__shutdown-socket`);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Fixture WebSocket did not become ready.')),
            5000
          );
          socket.onmessage = () => {
            clearTimeout(timer);
            resolve();
          };
          socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Fixture WebSocket failed to connect.'));
          };
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        process.kill(pid, 'SIGTERM');
        expect(await fixture.waitForExit(15_000)).toBe(0);
        const diagnostics = fixture.diagnostics();
        expect(diagnostics).toContain('shutdown-fixture:external-reaped');
        expect(diagnostics).toContain('shutdown-fixture:terminals-closed');
        expect(diagnostics).toContain('shutdown-fixture:runtime-closed');
        expect(existsSync(pidFile)).toBe(false);
      } finally {
        socket.close();
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    TEST_TIMEOUT_MS
  );

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

  it.skipIf(process.platform === 'win32')(
    'reports a failed HTTP drain, removes state and releases ownership at process exit',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const preload = fileURLToPath(
        new URL('../../support/fixtures/failing-http-shutdown.ts', import.meta.url)
      );
      const database = join(fixture.tempDir, 'drain-failure.sqlite');
      const { pidFile } = await startServing(fixture, preload, { databasePath: database });
      expect(await fixture.stop('SIGTERM')).toBe(1);
      expect(fixture.diagnostics()).toContain('fixture HTTP drain failed');
      expect(existsSync(pidFile)).toBe(false);
      const release = await acquireCaptureLock(database);
      await release();
      const reopened = new SQLiteDatabase(database, { readonly: true });
      try {
        expect(reopened.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      } finally {
        reopened.close();
      }
    },
    TEST_TIMEOUT_MS
  );

  it.skipIf(process.platform === 'win32')(
    'reports a hung HTTP drain as a timed-out failure and retains ownership until exit',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const running = fixture;
      const preload = fileURLToPath(
        new URL('../../support/fixtures/hung-http-shutdown.ts', import.meta.url)
      );
      const database = join(running.tempDir, 'hung-drain.sqlite');
      const { pidFile } = await startServing(running, preload, { databasePath: database });
      const stopped = running.stop('SIGTERM');
      await running.waitUntilReady(
        () => running.diagnostics().includes('shutdown-fixture: HTTP drain will not settle'),
        { label: 'hung HTTP drain', timeoutMs: START_TIMEOUT_MS }
      );
      await expect(acquireCaptureLock(database)).rejects.toThrow('already in use');
      expect(await stopped).toBe(1);
      expect(running.diagnostics()).toContain('Shutdown did not complete within 2000ms');
      expect(existsSync(pidFile)).toBe(true);
      const release = await acquireCaptureLock(database);
      await release();
    },
    TEST_TIMEOUT_MS
  );

  it.skipIf(process.platform === 'win32')(
    'keeps capture ownership while concurrent handle stops wait for the same HTTP drain',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const running = fixture;
      const entry = fileURLToPath(
        new URL('../../support/fixtures/gated-duplicate-server-stop.ts', import.meta.url)
      );
      const database = join(running.tempDir, 'duplicate-stop.sqlite');
      const child = running.spawn({
        cmd: ['bun', entry],
        env: {
          ...serverEnv(running.tempDir, running.port),
          DATABASE_PATH: database,
          BETTER_AUTH_SECRET: VALID_AUTH_SECRET,
        },
      });
      const checkpoint = 'shutdown-fixture: duplicate stop while HTTP drain is gated';
      try {
        await running.waitUntilReady(
          () => child.exitCode !== null || running.diagnostics().includes(checkpoint),
          { label: 'duplicate handle stop during HTTP drain', timeoutMs: START_TIMEOUT_MS }
        );
        expect(running.diagnostics()).toContain(checkpoint);
        const ownership = await acquireCaptureLock(database).then(
          async (release) => {
            await release();
            return 'capture lock was available during HTTP drain';
          },
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        expect(ownership).toContain('already in use');
      } finally {
        child.kill('SIGUSR2');
      }
      expect(await running.waitForExit()).toBe(0);
      const release = await acquireCaptureLock(database);
      await release();
    },
    TEST_TIMEOUT_MS
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the capture lock after HTTP closes until detached product work settles',
    async () => {
      if (!fixture) throw new Error('Expected a managed process fixture.');
      const running = fixture;
      const preload = fileURLToPath(
        new URL('../../support/fixtures/gated-product-operation-shutdown.ts', import.meta.url)
      );
      const database = join(running.tempDir, 'detached-operation.sqlite');
      await startServing(running, preload, { databasePath: database });
      const child = running.child;
      if (!child) throw new Error('Expected a running Hub child.');
      const checkpoint = 'shutdown-fixture: waiting for tracked product operation';
      child.kill('SIGTERM');
      await running.waitUntilReady(
        () => child.exitCode !== null || running.diagnostics().includes(checkpoint),
        { label: 'tracked operation drain or Hub exit', timeoutMs: START_TIMEOUT_MS }
      );
      expect(running.diagnostics()).toContain(checkpoint);
      expect(await probeHealthOnce('127.0.0.1', running.port)).toBe(false);
      await expect(acquireCaptureLock(database)).rejects.toThrow('already in use');

      child.kill('SIGUSR2');
      expect(await running.waitForExit()).toBe(0);
      const release = await acquireCaptureLock(database);
      await release();

      const reopened = new SQLiteDatabase(database, { readonly: true });
      try {
        expect(
          reopened
            .query(
              "SELECT name FROM sqlite_master WHERE name = 'fixture_finished_product_operation'"
            )
            .get()
        ).toEqual({ name: 'fixture_finished_product_operation' });
      } finally {
        reopened.close();
      }
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
