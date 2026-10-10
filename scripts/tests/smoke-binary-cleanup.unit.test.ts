import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// scripts/release/smoke-binary.sh is a bash helper that boots a POSIX
// executable; the fake server below is a shebang script. Linux and macOS only.
const ON_WINDOWS = process.platform === 'win32';

const RELEASE_DIR = join(import.meta.dir, '..', 'release');
const FAKE_SERVER_SOURCE = join(import.meta.dir, 'support', 'fake-smoke-server.ts');
const EXPECTED_VERSION = '0.0.0-fake-smoke-server';
const STARTUP_BUDGET_MS = 10_000;
const HELPER_BUDGET_MS = 30_000;
// Each test passes its own timeout (budget + 5 s): the lane default of 15 s is shorter
// than the helper's 30 s budget, which a loaded host can legitimately use.

type ServerEvent = { event: string; pid: number; at: number; args?: string[]; executable?: string };
type ServerState = 'running' | 'exited' | 'killed';

const scratchRoots: string[] = [];
const spawnedServers = new Set<number>();

afterEach(() => {
  for (const pid of spawnedServers) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  spawnedServers.clear();
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Whether a process with this pid exists.
 *
 * @example
 * isAlive(process.pid); // true
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the occurrences the fake server recorded so far.
 *
 * @example
 * readEvents('/tmp/run/events.jsonl'); // [{ event: 'startup', pid: 4242, ... }]
 */
function readEvents(eventsPath: string): ServerEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ServerEvent);
}

/**
 * What became of the fake server: still `running`, gone after its own `exited`
 * marker, or `killed` (gone without the marker, so it never shut down itself).
 *
 * @example
 * serverState(readEvents(eventsPath), startup.pid); // 'exited'
 */
function serverState(events: readonly ServerEvent[], pid: number): ServerState {
  if (isAlive(pid)) return 'running';
  return events.some((entry) => entry.event === 'exit' && entry.pid === pid) ? 'exited' : 'killed';
}

/**
 * The single startup the fake recorded, failing with what was recorded
 * otherwise.
 *
 * @example
 * startupOf(readEvents(eventsPath)).pid;
 */
function startupOf(events: readonly ServerEvent[]): ServerEvent {
  const startups = events.filter((entry) => entry.event === 'startup');
  if (startups.length !== 1) {
    throw new Error(
      `expected startups: 1 | received: ${startups.length} in ${JSON.stringify(events)}`
    );
  }
  return startups[0] as ServerEvent;
}

/**
 * Poll the events file until the fake has started, so the test never signals a
 * server that is not listening yet.
 *
 * @example
 * await awaitStartup('/tmp/run/events.jsonl');
 */
async function awaitStartup(eventsPath: string): Promise<ServerEvent> {
  const deadline = Date.now() + STARTUP_BUDGET_MS;
  while (Date.now() < deadline) {
    if (readEvents(eventsPath).some((entry) => entry.event === 'startup')) {
      return startupOf(readEvents(eventsPath));
    }
    await Bun.sleep(20);
  }
  throw new Error(
    `expected a startup event within ${STARTUP_BUDGET_MS}ms | received: ${JSON.stringify(readEvents(eventsPath))}`
  );
}

/**
 * Ask the OS for a free loopback port, so concurrent test files never share one.
 *
 * @example
 * const port = await freePort(); // 54123
 */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

type SmokeRoot = { root: string; binary: string; helper: string; eventsPath: string };

/**
 * Lay out a disposable repo root holding byte copies of the real smoke helper
 * and its health helper, plus the fake server as an executable. A copy keeps a
 * locally built `apps/frontend/dist` out of the helper's dist-parity check.
 *
 * @example
 * const { helper, binary, eventsPath } = stageSmokeRoot();
 */
function stageSmokeRoot(): SmokeRoot {
  const root = mkdtempSync(join(tmpdir(), 'mango-smoke-cleanup-'));
  scratchRoots.push(root);
  const releaseDir = join(root, 'scripts', 'release');
  mkdirSync(releaseDir, { recursive: true });
  for (const name of ['smoke-binary.sh', 'wait-for-health.sh']) {
    copyFileSync(join(RELEASE_DIR, name), join(releaseDir, name));
  }
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const binary = join(binDir, 'mangostudio');
  writeFileSync(binary, `#!${process.execPath}\n${readFileSync(FAKE_SERVER_SOURCE, 'utf8')}`);
  chmodSync(binary, 0o755);
  return {
    root,
    binary,
    helper: join(releaseDir, 'smoke-binary.sh'),
    eventsPath: join(root, 'events.jsonl'),
  };
}

describe('scripts/release/smoke-binary.sh server cleanup', () => {
  test.skipIf(ON_WINDOWS)(
    'the fake server stays running until it is signalled, then exits by itself',
    async () => {
      const { binary, eventsPath } = stageSmokeRoot();
      const port = await freePort();
      const server = Bun.spawn([binary, 'serve', `127.0.0.1:${port}`], {
        env: {
          ...process.env,
          FAKE_SMOKE_SERVER_EVENTS: eventsPath,
          FAKE_SMOKE_SERVER_VERSION: EXPECTED_VERSION,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      spawnedServers.add(server.pid);

      const startup = await awaitStartup(eventsPath);
      const beforeSignal = serverState(readEvents(eventsPath), startup.pid);
      expect(beforeSignal, `expected server state: running | received: ${beforeSignal}`).toBe(
        'running'
      );

      server.kill('SIGTERM');
      await server.exited;

      const events = readEvents(eventsPath);
      const afterSignal = serverState(events, startup.pid);
      expect(afterSignal, `expected server state: exited | received: ${afterSignal}`).toBe(
        'exited'
      );
      const signals = events.filter((entry) => entry.event === 'sigterm').length;
      expect(signals, `expected SIGTERM count: 1 | received: ${signals}`).toBe(1);
    },
    STARTUP_BUDGET_MS + 5_000
  );

  test.skipIf(ON_WINDOWS)(
    'returns only after the staged server it started received one SIGTERM and exited',
    async () => {
      const { binary, helper, eventsPath } = stageSmokeRoot();
      const port = await freePort();

      const smoke = Bun.spawn(['bash', helper, binary, EXPECTED_VERSION, String(port)], {
        env: {
          ...process.env,
          FAKE_SMOKE_SERVER_EVENTS: eventsPath,
          FAKE_SMOKE_SERVER_VERSION: EXPECTED_VERSION,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: HELPER_BUDGET_MS,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(smoke.stdout).text(),
        new Response(smoke.stderr).text(),
        smoke.exited,
      ]);
      // Read once, right after the helper returned: a server still shutting
      // down at this instant is exactly the leak this test exists to catch.
      const events = readEvents(eventsPath);

      expect(
        exitCode,
        `expected smoke exit code: 0 | received: ${exitCode}\n${stdout}${stderr}`
      ).toBe(0);
      expect(stdout).toContain('served /api/health, / and /assets/index-fake.js');

      const startup = startupOf(events);
      spawnedServers.add(startup.pid);
      expect(startup.args).toEqual(['serve', `127.0.0.1:${port}`]);
      // The smoke boots a staged copy, never the binary it was handed.
      expect(basename(dirname(startup.executable ?? ''))).toBe('staging');

      const state = serverState(events, startup.pid);
      expect(state, `expected server state: exited | received: ${state}`).toBe('exited');
      const signals = events.filter((entry) => entry.event === 'sigterm').length;
      expect(signals, `expected SIGTERM count: 1 | received: ${signals}`).toBe(1);
    },
    HELPER_BUDGET_MS + 5_000
  );
});
