import { afterEach, beforeEach, describe, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { runCommand, runParallel } from '../lib/exec';
import { CANCEL_GRACE_MS } from '../lib/process-tree';
import { fixtureChildEnvironment } from './support/child-supervision';
import { isAlive, readProcessState } from './support/process-liveness';
import {
  ECHO_STDERR,
  ECHO_STDOUT,
  findGuardianPids,
  fixtureCommand,
  forceKill,
  forceKillGroup,
  processGroupOf,
  readGrandchildPid,
  readReadyPids,
  readWorkerPids,
  type ReadyPids,
  RELEASE_FILE,
  sessionOf,
  SIGNALS_LOG,
  waitFor,
  WORKERS_LOG,
} from './support/process-tree';

// A cancelled runner has to take everything it started with it. These tests run
// the fakes from `support/process-tree.ts` as real processes and look at which
// pids are still alive afterwards: what a cancelled runner leaves behind is an
// operating-system fact that no in-process stub can stand in for.

const IS_WINDOWS = process.platform === 'win32';
const READY_TIMEOUT_MS = 10_000;
// Allow a descendant's state to settle after cancellation. This is shorter
// than the 3 s the slow grandchild takes to stop.
const SETTLE_TIMEOUT_MS = 1_000;
/** Per-test limit for cases that wait out a cancel grace (5 s); Bun's default is 5 s. */
const GRACE_TEST_TIMEOUT_MS = 15_000;

type RunnerProcess = ReturnType<typeof Bun.spawn>;

/**
 * Inherited supervision settings are scrubbed from the fakes so these tests
 * exercise the runner's own groups and signal forwarding. Bun's worker flag
 * carries --no-orphans to children through an internal environment variable;
 * its automatic teardown would compete with the fake's signal handlers.
 * The test worker itself keeps that policy, including its descendant cleanup.
 */
const RUNNER_ENV = ['MANGO_RUNNER_GROUP', 'MANGO_RUNNER_CONCURRENCY'] as const;

function fakeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = fixtureChildEnvironment();
  for (const name of RUNNER_ENV) delete env[name];
  return { ...env, ...extra };
}

/** What `signalDeliveries()` reads when the child and grandchild each got one SIGINT. */
const ONCE_EACH = 'child SIGINT x1, grandchild SIGINT x1';

let dir = '';
const spawned: RunnerProcess[] = [];
/** Guardians found while their runner was alive, so cleanup can reach them after it is not. */
const guardians: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-process-tree-'));
});

afterEach(() => {
  // A failing assertion must not leave 60-second fakes behind: stop the runner's
  // group, every pid the fakes reported, and every worker that logged a start.
  for (const runner of spawned.splice(0)) {
    forceKillGroup(runner.pid);
    forceKill(runner.pid);
  }
  for (const guardian of guardians.splice(0)) forceKill(guardian);
  const pids = readReadyPids(dir);
  if (pids) {
    forceKill(pids.child);
    forceKill(pids.grandchild);
  }
  const grandchild = readGrandchildPid(dir);
  if (grandchild) forceKill(grandchild);
  for (const worker of readWorkerPids(dir)) forceKill(worker);
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

/** Launch the real production CLI/default executor, replacing only external Bun commands. */
function startProductionRunner(heldPhase: string): RunnerProcess {
  const bin = join(dir, "production bin's");
  mkdirSync(bin);
  for (const [name, phase] of [
    ['bun', 'build'],
    ['bunx', 'browser'],
  ] as const) {
    const command = fixtureCommand('production-command', dir, phase, heldPhase)
      .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
      .join(' ');
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${command} "$@"\n`, {
      mode: 0o755,
    });
  }
  const runner = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'browser-production.ts')],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: fakeEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }),
    }
  );
  spawned.push(runner);
  return runner;
}

/** A runner whose stdin, stdout and stderr are the terminal it leads. */
interface TerminalRunner {
  readonly proc: RunnerProcess;
  /** Types at the terminal, as a person would: `type('\x03')` is Ctrl-C. */
  type(text: string): void;
}

/**
 * Starts the fake runner on a pseudo-terminal it is the session leader of, so a
 * Ctrl-C typed at it is delivered by the kernel to the foreground group exactly
 * as it is in a shell, and the runner's stdin is a TTY.
 */
function startTerminalRunner(args: string[] = []): TerminalRunner {
  const proc = Bun.spawn(fixtureCommand('runner', dir, ...args), {
    terminal: { cols: 100, rows: 30, data: () => undefined },
    env: fakeEnv(),
  });
  spawned.push(proc);
  return { proc, type: (text) => proc.terminal?.write(text) };
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

/**
 * The guardian the live runner started. It exists before the runner's first child
 * does, so once `readyPids` returned it is there to be found.
 */
async function guardianOf(runner: RunnerProcess): Promise<number> {
  await waitFor(() => findGuardianPids(runner.pid).length > 0, READY_TIMEOUT_MS);
  const found = findGuardianPids(runner.pid);
  guardians.push(...found);
  if (found.length !== 1) {
    throw new Error(`expected guardians of runner ${runner.pid}: 1 | received: ${found.length}`);
  }
  return found[0] as number;
}

/** Waits for the pids to stop executing and reports live processes. */
async function stillAlive(pids: number[]): Promise<number[]> {
  await waitFor(() => pids.every((pid) => !isAlive(pid)), SETTLE_TIMEOUT_MS);
  return pids.filter((pid) => isAlive(pid));
}

/**
 * Nothing may outlive the cancelled runner. The grandchild is checked first and
 * reported as the live "descendant": it is the part a runner that only stops its
 * direct child never reaches. The fake child is the direct child.
 */
async function expectNothingLeft(pids: ReadyPids): Promise<void> {
  for (const [label, role, pid] of [
    ['descendants', 'grandchild', pids.grandchild],
    ['children', 'child', pids.child],
  ] as const) {
    if ((await stillAlive([pid])).length > 0) {
      const state = readProcessState(pid) ?? 'absent';
      throw new Error(
        `expected live ${label}: 0 | received: 1 (${role} pid ${pid}, last state ${state}, signals ${signalDeliveries()})`
      );
    }
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
  test.skipIf(IS_WINDOWS)('counts a stopped parent and excludes its unreaped zombie', async () => {
    startRunner();
    const { child, grandchild } = await readyPids();
    process.kill(child, 'SIGSTOP');
    try {
      await waitFor(() => readProcessState(child) === 'T', READY_TIMEOUT_MS);
      expectValue(`state of stopped child ${child}`, 'T', readProcessState(child));

      // Hold the parent stopped so the kernel retains the exited child's state.
      process.kill(grandchild, 'SIGKILL');
      await waitFor(() => readProcessState(grandchild) === 'Z', READY_TIMEOUT_MS);
      expectValue(`state of unreaped grandchild ${grandchild}`, 'Z', readProcessState(grandchild));

      const liveGrandchildren = await stillAlive([grandchild]);
      expectValue('live fixture grandchild PIDs', '', liveGrandchildren.join(','));
      expectValue(`stopped fixture parent ${child} is alive`, true, isAlive(child));
    } finally {
      process.kill(child, 'SIGCONT');
    }
  });

  test.skipIf(IS_WINDOWS).each(['build', 'browser'])(
    'production %s cancellation settles owned descendants and never admits a later phase',
    async (phase) => {
      const runner = startProductionRunner(phase);
      const pids = await readyPids();

      runner.kill('SIGTERM');
      await runner.exited;

      await expectNothingLeft(pids);
      const admitted = readFileSync(join(dir, 'production-phases.log'), 'utf8').trim().split('\n');
      expectValue(
        'production admitted phases',
        phase === 'build' ? 'production:build' : 'production:build,production:browser',
        admitted.join(',')
      );
    }
  );

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

  // The leader dying says nothing about the rest of its group: a worker with a
  // handler that swallows SIGTERM, or one that takes seconds to wind down, is
  // still running when the leader is gone. Nothing may outlive the runner.
  describe.skipIf(IS_WINDOWS)('a group member that outlives its leader', () => {
    test(
      'SIGTERM still stops a grandchild that ignores it',
      async () => {
        const runner = startRunner(['child', 'linger:0', 'ignore']);
        const pids = await readyPids();

        runner.kill('SIGTERM');
        await runner.exited;

        await expectNothingLeft(pids);
      },
      GRACE_TEST_TIMEOUT_MS
    );

    test('the runner waits for a grandchild that needs 3 s to stop', async () => {
      const runner = startRunner(['child', 'linger:0', 'linger:3000']);
      const pids = await readyPids();

      runner.kill('SIGTERM');
      await runner.exited;

      await expectNothingLeft(pids);
    });
  });

  // An interactive child shares the runner's group, so a Ctrl-C typed at the
  // terminal reaches it from the kernel. A SIGINT sent to the runner alone (a
  // `kill -INT`, a supervisor) reaches nothing, and the runner has to pass it on.
  describe.skipIf(IS_WINDOWS)('an interactive child (stdin inherited)', () => {
    test('gets a SIGINT that came from no terminal, once', async () => {
      const runner = startRunner(['interactive']);
      await readyPids();

      runner.kill('SIGINT');
      await runner.exited;

      expectValue('SIGINT deliveries', 'child SIGINT x1', signalDeliveries());
    });

    test('gets Ctrl-C typed at the terminal exactly once', async () => {
      const runner = startTerminalRunner(['interactive']);
      const pids = await readyPids();

      runner.type('\x03');
      await runner.proc.exited;
      await expectNothingLeft(pids);

      expectValue('SIGINT deliveries', ONCE_EACH, signalDeliveries());
    });

    test('gets SIGTERM, not a second SIGINT, when a terminal run is interrupted from outside', async () => {
      const runner = startTerminalRunner(['interactive']);
      await readyPids();

      runner.proc.kill('SIGINT');
      await runner.proc.exited;

      expectValue('deliveries', 'child SIGTERM x1', signalDeliveries());
    });
  });

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
      const runner = startRunner([], true, {
        MANGO_RUNNER_GROUP: String(process.pid),
      });
      const pids = await readyPids();

      expectValue('nested runner child process group', runner.pid, processGroupOf(pids.child));
      expectValue(
        'nested runner grandchild process group',
        runner.pid,
        processGroupOf(pids.grandchild)
      );
    });

    // The marker names the runner that spawned the group leader. One that does
    // not (inherited by a process that left the group, or outlived its owner)
    // protects nothing, so the runner has to protect itself.
    test('a marker that does not describe this process is ignored', async () => {
      const runner = startRunner([], true, { MANGO_RUNNER_GROUP: '1' });
      const pids = await readyPids();

      expectValue(
        'child process group under a stale marker',
        pids.child,
        processGroupOf(pids.child)
      );

      runner.kill('SIGTERM');
      await runner.exited;
      await expectNothingLeft(pids);
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

    test('typed at a real terminal, reaches each of them exactly once', async () => {
      const runner = startTerminalRunner();
      const pids = await readyPids();

      runner.type('\x03');
      await runner.proc.exited;
      await expectNothingLeft(pids);

      expectValue('SIGINT deliveries', ONCE_EACH, signalDeliveries());
    });

    // The runner above owns the group both of them are in, so the group signal
    // is the only one; a nested runner that forwarded too would make it two.
    test('reaches the children of a nested runner exactly once', async () => {
      const runner = startRunner([], true, {
        MANGO_RUNNER_GROUP: String(process.pid),
      });
      const pids = await readyPids();

      process.kill(-runner.pid, 'SIGINT');
      await runner.exited;
      await expectNothingLeft(pids);

      expectValue('SIGINT deliveries', ONCE_EACH, signalDeliveries());
    });
  });
});

/** Fails with `(runner guardian): expected <what>: <expected> | received: <actual>`. */
function expectGuarded(what: string, expected: unknown, actual: unknown): void {
  if (Object.is(expected, actual)) return;
  throw new Error(
    `(runner guardian): expected ${what}: ${String(expected)} | received: ${String(actual)}`
  );
}

// SIGKILL cannot be caught, so the runner forwards nothing. The guardian it
// started, which holds the other end of a pipe from it, sees the pipe close and
// stops what the runner had registered.
describe.skipIf(IS_WINDOWS)('SIGKILL of the runner', () => {
  /** Longer than the grace a SIGTERM-ignoring member gets, with room for a slow host. */
  const KILL_BOUND_MS = CANCEL_GRACE_MS + 3_000;

  /**
   * Waits for the fixture pids to stop running within `ms`, and names the ones
   * that did not as `child <pid>, grandchild <pid>`; empty when none is left.
   */
  async function survivorsAfter(
    pids: Readonly<Record<string, number>>,
    ms: number
  ): Promise<string> {
    await waitFor(() => Object.values(pids).every((pid) => !isAlive(pid)), ms);
    return Object.entries(pids)
      .filter(([, pid]) => isAlive(pid))
      .map(([role, pid]) => `${role} ${pid}`)
      .join(', ');
  }

  test('stops the child and a grandchild that takes a moment to leave', async () => {
    const runner = startRunner(['child', 'linger:0', 'linger:1000']);
    const pids = await readyPids();

    runner.kill('SIGKILL');
    expectGuarded('runner exit status', 137, await runner.exited);

    const left = await survivorsAfter(
      { child: pids.child, grandchild: pids.grandchild },
      KILL_BOUND_MS
    );
    expectGuarded('live fixture pids after the runner was killed', '', left);
    expectGuarded(
      'signals the guardian sent',
      'child SIGTERM x1, grandchild SIGTERM x1',
      signalDeliveries()
    );
  });

  test(
    'SIGKILLs a grandchild that ignores SIGTERM once the grace has passed',
    async () => {
      const runner = startRunner(['child', 'linger:0', 'ignore']);
      const pids = await readyPids();

      const killedAt = Date.now();
      runner.kill('SIGKILL');
      await runner.exited;

      // Still running well inside the grace: SIGTERM alone did not move it.
      await Bun.sleep(CANCEL_GRACE_MS / 2);
      expectGuarded('grandchild running inside the grace', true, isAlive(pids.grandchild));

      const left = await survivorsAfter(
        { child: pids.child, grandchild: pids.grandchild },
        KILL_BOUND_MS
      );
      expectGuarded('live fixture pids after the grace', '', left);
      expectGuarded(
        'grandchild outlived SIGTERM for at least the grace',
        true,
        Date.now() - killedAt >= CANCEL_GRACE_MS - 250
      );
    },
    GRACE_TEST_TIMEOUT_MS
  );

  // Only procps can name a session; see `sessionOf`.
  test.skipIf(process.platform !== 'linux')(
    'leaves the guardian in a session of its own',
    async () => {
      const runner = startRunner([], true);
      await readyPids();
      const guardian = await guardianOf(runner);

      expectGuarded('guardian session', guardian, sessionOf(guardian));
    }
  );

  test('leaves the guardian in a process group of its own', async () => {
    const runner = startRunner([], true);
    await readyPids();
    const guardian = await guardianOf(runner);

    expectGuarded('guardian process group', guardian, processGroupOf(guardian));
    expectGuarded(
      'runner process group apart from guardian',
      runner.pid,
      processGroupOf(runner.pid)
    );
  });

  test('ignores the cancelling signals sent to it', async () => {
    const runner = startRunner();
    await readyPids();
    const guardian = await guardianOf(runner);

    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.kill(guardian, name);
    await Bun.sleep(300);

    expectGuarded('guardian running after SIGINT, SIGTERM and SIGHUP', true, isAlive(guardian));
  });

  // The runner's group is the terminal's foreground group, shared with the shell
  // and whatever else is in the job, so the guardian signals the child's pid and
  // nothing wider: the grandchild, in the same group, is left to its own devices.
  test('signals only the pid of an interactive child, never the group it shares', async () => {
    const runner = startRunner(['interactive'], true);
    const pids = await readyPids();
    const guardian = await guardianOf(runner);

    runner.kill('SIGKILL');
    await runner.exited;

    const childLeft = await survivorsAfter({ child: pids.child }, KILL_BOUND_MS);
    expectGuarded('live interactive child', '', childLeft);
    const guardianLeft = await survivorsAfter({ guardian }, KILL_BOUND_MS);
    expectGuarded('live guardian once its only entry is gone', '', guardianLeft);
    expectGuarded('group-mate grandchild still running', true, isAlive(pids.grandchild));
    expectGuarded('signals the guardian sent', 'child SIGTERM x1', signalDeliveries());
  });
});

describe.skipIf(IS_WINDOWS)('the guardian when the runner is not killed', () => {
  test('ends with the runner on a normal exit', async () => {
    const runner = startRunner(['worker']);
    await waitFor(() => readWorkerPids(dir).length > 0, READY_TIMEOUT_MS);
    const guardian = await guardianOf(runner);

    writeFileSync(join(dir, RELEASE_FILE), 'go');
    expectGuarded('runner exit status', 0, await runner.exited);

    const left = await waitFor(() => !isAlive(guardian), 2_000);
    expectGuarded('guardian gone after a normal runner exit', true, left);
  });

  test('ends with the runner on SIGTERM, after the runner stopped its children', async () => {
    const runner = startRunner();
    const pids = await readyPids();
    const guardian = await guardianOf(runner);

    runner.kill('SIGTERM');
    expectGuarded('runner exit status', 143, await runner.exited);

    await expectNothingLeft(pids);
    expectGuarded('guardian gone', true, await waitFor(() => !isAlive(guardian), 2_000));
    // The runner stopped them once; a guardian acting as well would make it two.
    expectGuarded(
      'SIGTERM deliveries',
      'child SIGTERM x1, grandchild SIGTERM x1',
      signalDeliveries()
    );
  });

  test('is not started by a nested runner, whose children the runner above covers', async () => {
    const runner = startRunner([], true, {
      MANGO_RUNNER_GROUP: String(process.pid),
    });
    await readyPids();

    expectGuarded('guardians of a nested runner', '', findGuardianPids(runner.pid).join(','));
  });

  test('a guardian that died does not change how the runner ends', async () => {
    const runner = startRunner(['worker']);
    await waitFor(() => readWorkerPids(dir).length > 0, READY_TIMEOUT_MS);
    const guardian = await guardianOf(runner);

    forceKill(guardian);
    await waitFor(() => !isAlive(guardian), 2_000);
    writeFileSync(join(dir, RELEASE_FILE), 'go');

    expectGuarded('runner exit status with its guardian dead', 0, await runner.exited);
    const stderr = await readText(runner.stderr as ReadableStream<Uint8Array>);
    expectGuarded('unhandled error on stderr', false, /unhandled|error:/i.test(stderr));
  });
});

// A runner that has signalled its children itself tells the guardian so (the
// `stopping` line), and the guardian then sends no second SIGTERM: a tool that
// reads a repeated SIGTERM as "force quit" would lose its graceful shutdown.
describe.skipIf(IS_WINDOWS)('a runner that signalled its children and then went away', () => {
  const KILL_BOUND_MS = CANCEL_GRACE_MS + 3_000;
  const ONE_SIGTERM_EACH = 'child SIGTERM x1, grandchild SIGTERM x1';

  /** The fake runner that calls `process.exit` while its child is live. */
  function startExitingRunner(args: string[]): RunnerProcess {
    const runner = Bun.spawn(fixtureCommand('runner-exit', dir, ...args), {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: fakeEnv(),
    });
    spawned.push(runner);
    return runner;
  }

  async function expectBothGone(pids: ReadyPids): Promise<void> {
    await waitFor(() => !isAlive(pids.child) && !isAlive(pids.grandchild), KILL_BOUND_MS);
    const left = [pids.child, pids.grandchild].filter((pid) => isAlive(pid));
    expectGuarded('live fixture pids', '', left.join(','));
  }

  test(
    'process.exit with a live child gives it one SIGTERM, not a second from the guardian',
    async () => {
      const runner = startExitingRunner(['linger:1000', 'linger:1000']);
      const pids = await readyPids();
      const guardian = await guardianOf(runner);

      writeFileSync(join(dir, RELEASE_FILE), 'go');
      expectGuarded('runner exit status', 0, await runner.exited);
      await expectBothGone(pids);
      expectGuarded(
        'guardian gone after the children left',
        true,
        await waitFor(() => !isAlive(guardian), 2_000)
      );
      expectGuarded('SIGTERM deliveries', ONE_SIGTERM_EACH, signalDeliveries());
    },
    GRACE_TEST_TIMEOUT_MS
  );

  test(
    'SIGKILL during the grace that follows a SIGTERM adds no second SIGTERM, then SIGKILLs the survivors',
    async () => {
      const runner = startRunner(['child', 'ignore', 'ignore']);
      const pids = await readyPids();
      await guardianOf(runner);

      runner.kill('SIGTERM');
      await waitFor(() => signalDeliveries() === ONE_SIGTERM_EACH, READY_TIMEOUT_MS);
      runner.kill('SIGKILL');
      await runner.exited;

      // Both ignore SIGTERM, so only the guardian's SIGKILL after the grace removes them.
      await expectBothGone(pids);
      expectGuarded('SIGTERM deliveries', ONE_SIGTERM_EACH, signalDeliveries());
    },
    GRACE_TEST_TIMEOUT_MS
  );
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
