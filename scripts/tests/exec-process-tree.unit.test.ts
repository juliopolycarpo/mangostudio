import { afterEach, beforeEach, describe, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand, runParallel } from '../lib/exec';
import {
  ECHO_STDERR,
  ECHO_STDOUT,
  fixtureCommand,
  forceKill,
  isAlive,
  processGroupOf,
  RELEASE_FILE,
  type ReadyPids,
  readReadyPids,
  SIGNALS_LOG,
  WORKERS_LOG,
  waitFor,
} from './support/process-tree';

// A cancelled runner has to take everything it started with it. These tests run
// the fakes from `support/process-tree.ts` as real processes and look at which
// pids are still alive afterwards: what a cancelled runner leaves behind is an
// operating-system fact that no in-process stub can stand in for.

const IS_WINDOWS = process.platform === 'win32';
const READY_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 4_000;

type RunnerProcess = ReturnType<typeof Bun.spawn>;

/**
 * The variables that make a runner behave as nested or bound its fan-out. They
 * are scrubbed from the environment the fakes inherit, because this suite runs
 * under `bun run test`, whose runner has set them for its own children.
 */
const RUNNER_ENV = ['MANGO_RUNNER_GROUP', 'MANGO_RUNNER_CONCURRENCY'] as const;

function fakeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of RUNNER_ENV) delete env[name];
  return { ...env, ...extra };
}

/** What `signalDeliveries()` reads when the child and grandchild each got one SIGINT. */
const ONCE_EACH = 'child SIGINT x1, grandchild SIGINT x1';

let dir = '';
const spawned: RunnerProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-process-tree-'));
});

afterEach(() => {
  // A failing assertion must not leave 60-second fakes behind.
  for (const runner of spawned.splice(0)) forceKill(runner.pid);
  const pids = readReadyPids(dir);
  if (pids) {
    forceKill(pids.child);
    forceKill(pids.grandchild);
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Starts the fake root runner. `leader` makes it a process-group leader, which
 * is how an interactive shell starts a foreground job, so a signal sent to the
 * group is what the terminal's Ctrl-C does.
 */
function startRunner(
  args: string[] = [],
  leader = false,
  extraEnv: Record<string, string> = {}
): RunnerProcess {
  const runner = Bun.spawn(fixtureCommand('runner', dir, ...args), {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: leader && !IS_WINDOWS,
    env: fakeEnv(extraEnv),
  });
  spawned.push(runner);
  return runner;
}

async function readyPids(): Promise<ReadyPids> {
  const ready = await waitFor(() => readReadyPids(dir) !== undefined, READY_TIMEOUT_MS);
  const pids = readReadyPids(dir);
  if (!ready || !pids) {
    throw new Error(
      `expected fake child ready within ${READY_TIMEOUT_MS}ms | received: no ready.json`
    );
  }
  return pids;
}

/** Waits for the pids to exit and returns the ones that did not. */
async function stillAlive(pids: number[]): Promise<number[]> {
  await waitFor(() => pids.every((pid) => !isAlive(pid)), SETTLE_TIMEOUT_MS);
  return pids.filter(isAlive);
}

/**
 * Nothing may outlive the cancelled runner. The grandchild is checked first and
 * reported as the live "descendant": it is the part a runner that only stops its
 * direct child never reaches. The fake child is the direct child.
 */
async function expectNothingLeft(pids: ReadyPids): Promise<void> {
  const descendants = await stillAlive([pids.grandchild]);
  if (descendants.length > 0) {
    throw new Error(
      `expected live descendants: 0 | received: ${descendants.length} (grandchild pid ${descendants.join(', ')})`
    );
  }
  const children = await stillAlive([pids.child]);
  if (children.length > 0) {
    throw new Error(
      `expected live children: 0 | received: ${children.length} (child pid ${children.join(', ')})`
    );
  }
}

/** Fails with `expected <what>: <expected> | received: <actual>`, whatever the values. */
function expectValue(what: string, expected: unknown, actual: unknown): void {
  if (Object.is(expected, actual)) return;
  throw new Error(`expected ${what}: ${String(expected)} | received: ${String(actual)}`);
}

/** Reads what a stream holds, giving up when a surviving child keeps the pipe open. */
function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('<output still open after 3000ms>'), 3_000);
  });
  return Promise.race([new Response(stream).text(), timeout]).finally(() => clearTimeout(timer));
}

/** The signals the fakes logged, as sorted `<role> <signal> x<count>` entries. */
function signalDeliveries(): string {
  const file = join(dir, SIGNALS_LOG);
  if (!existsSync(file)) return 'none';
  const counts = new Map<string, number>();
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([line, count]) => `${line} x${count}`)
    .join(', ');
}

describe('cancelling a runner', () => {
  test('SIGTERM to the runner stops its child and the grandchild', async () => {
    const runner = startRunner();
    const pids = await readyPids();

    runner.kill('SIGTERM');
    await runner.exited;

    await expectNothingLeft(pids);
  });

  test.skipIf(IS_WINDOWS)('SIGINT to the runner stops its child and the grandchild', async () => {
    const runner = startRunner();
    const pids = await readyPids();

    runner.kill('SIGINT');
    await runner.exited;

    await expectNothingLeft(pids);
  });

  test.skipIf(IS_WINDOWS)(
    'exits with the signal status and names the cancelled command',
    async () => {
      const runner = startRunner();
      await readyPids();

      runner.kill('SIGTERM');
      const exitCode = await runner.exited;
      const output = `${await readText(runner.stdout as ReadableStream<Uint8Array>)}${await readText(runner.stderr as ReadableStream<Uint8Array>)}`;

      expectValue('runner exit status', 143, exitCode);
      expectValue('cancelled command label in output', true, output.includes('fake-cargo'));
    }
  );

  describe.skipIf(IS_WINDOWS)('process groups', () => {
    test('a plain child leads a group of its own, apart from its runner', async () => {
      const runner = startRunner([], true);
      const pids = await readyPids();

      const childGroup = processGroupOf(pids.child);
      expectValue('child process group', pids.child, childGroup);
      expectValue('grandchild process group', pids.child, processGroupOf(pids.grandchild));
      expectValue('runner left in its own group', runner.pid, processGroupOf(runner.pid));
    });

    test('a nested runner leaves its children in the group it was given', async () => {
      const runner = startRunner([], true, { MANGO_RUNNER_GROUP: String(process.pid) });
      const pids = await readyPids();

      expectValue('nested runner child process group', runner.pid, processGroupOf(pids.child));
      expectValue(
        'nested runner grandchild process group',
        runner.pid,
        processGroupOf(pids.grandchild)
      );
    });

    test('an interactive child stays in the runner group, which holds the terminal', async () => {
      const runner = startRunner(['interactive'], true);
      const pids = await readyPids();

      expectValue('interactive child process group', runner.pid, processGroupOf(pids.child));
    });
  });

  // The terminal sends Ctrl-C to the whole foreground group, so the runner and
  // anything still in its group receive it from the kernel. A runner that moved
  // its children out of that group and also forwarded would be right; one that
  // left a child in the group and forwarded as well would deliver it twice.
  describe.skipIf(IS_WINDOWS)('Ctrl-C from the terminal', () => {
    test('reaches the child and the grandchild exactly once', async () => {
      const runner = startRunner([], true);
      const pids = await readyPids();

      process.kill(-runner.pid, 'SIGINT');
      await runner.exited;
      await expectNothingLeft(pids);

      expectValue('SIGINT deliveries', ONCE_EACH, signalDeliveries());
    });

    // The runner above owns the group both of them are in, so the group signal
    // is the only one; a nested runner that forwarded too would make it two.
    test('reaches the children of a nested runner exactly once', async () => {
      const runner = startRunner([], true, { MANGO_RUNNER_GROUP: String(process.pid) });
      const pids = await readyPids();

      process.kill(-runner.pid, 'SIGINT');
      await runner.exited;
      await expectNothingLeft(pids);

      expectValue('SIGINT deliveries', ONCE_EACH, signalDeliveries());
    });

    test('reaches an interactive child (stdin inherited) exactly once', async () => {
      const runner = startRunner(['interactive'], true);
      const pids = await readyPids();

      process.kill(-runner.pid, 'SIGINT');
      await runner.exited;
      await expectNothingLeft(pids);

      expectValue('SIGINT deliveries', ONCE_EACH, signalDeliveries());
    });
  });
});

describe('a child that fails', () => {
  test('keeps its label and exit code through runCommand and runParallel', async () => {
    const results = await runParallel([
      () => runCommand('lane-ok', fixtureCommand('exit', dir, '0')),
      () => runCommand('lane-23', fixtureCommand('exit', dir, '23')),
      () => runCommand('lane-ok-too', fixtureCommand('exit', dir, '0')),
    ]);

    const seen = results.map(({ label, exitCode }) => `${label}=${exitCode}`).join(' ');
    expectValue('labels and exit codes', 'lane-ok=0 lane-23=23 lane-ok-too=0', seen);
  });

  test('exits the runner with the same code', async () => {
    const runner = startRunner(['exit', '23']);

    expectValue('runner exit status', 23, await runner.exited);
  });

  test('streams the output of a child as it runs', async () => {
    const runner = startRunner(['echo']);

    expectValue('runner exit status', 0, await runner.exited);
    const stdout = await readText(runner.stdout as ReadableStream<Uint8Array>);
    const stderr = await readText(runner.stderr as ReadableStream<Uint8Array>);
    expectValue('child stdout on runner stdout', true, stdout.includes(ECHO_STDOUT));
    expectValue('child stderr on runner stderr', true, stderr.includes(ECHO_STDERR));
  });
});

describe('nested parallel runners', () => {
  const LIMIT = 3;
  const GROUPS = 3;
  const PER_GROUP = 4;

  function workerEvents(): string[] {
    const file = join(dir, WORKERS_LOG);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')[1] as string);
  }

  /** The most workers that were live at once, replaying the log in write order. */
  function peakConcurrent(): number {
    let live = 0;
    let peak = 0;
    for (const event of workerEvents()) {
      live += event === 'start' ? 1 : -1;
      peak = Math.max(peak, live);
    }
    return peak;
  }

  test('never run more children than the limit', async () => {
    const runner = Bun.spawn(fixtureCommand('fan-out', dir, String(GROUPS), String(PER_GROUP)), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: fakeEnv({ MANGO_RUNNER_CONCURRENCY: String(LIMIT) }),
    });
    spawned.push(runner);

    // Workers hold until released, so the live count is exactly what the
    // runner allowed: wait for the first wave, give any extra worker time to
    // show up, then read it.
    const firstWave = await waitFor(() => workerEvents().length >= LIMIT, READY_TIMEOUT_MS);
    await Bun.sleep(750);
    const started = workerEvents().length;
    writeFileSync(join(dir, RELEASE_FILE), 'go');
    const exitCode = await runner.exited;

    expectValue('first wave of workers started', true, firstWave);
    expectValue('concurrent children', LIMIT, started);
    expectValue('peak concurrent children', LIMIT, peakConcurrent());
    expectValue('fan-out exit status', 0, exitCode);
    const finished = workerEvents().filter((event) => event === 'end').length;
    expectValue('finished workers', GROUPS * PER_GROUP, finished);
  });
});
