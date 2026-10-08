// Named fake processes for the runner supervision tests.
//
// The fakes are real operating-system processes, because the behaviour under
// test (which pids survive a cancelled runner) does not exist in a mock. This
// file is both the helper the tests import and the program the fakes run:
//
//   bun scripts/tests/support/process-tree.ts <role> <dir> [args...]
//
//   runner       the fake root runner: `runCommand`s one fake child, like
//                `scripts/check.ts` runs `turbo`
//   child        the fake direct child (the `cargo` of the story): spawns one
//                grandchild, writes `ready.json` once the grandchild is up, then
//                waits to be stopped
//   grandchild   the fake grandchild (the `rustc`): only waits
//
// `child` and `grandchild` take a stop behaviour for SIGINT and SIGTERM:
// `linger:<ms>` (the default, 300) logs the signal and exits that long after it,
// so a duplicate delivery is also logged; `ignore` logs it and keeps running,
// the way a worker with a handler that swallows it does.
//   worker       one unit of fan-out work: logs `start`, waits for the test to
//                create `release`, logs `end`
//   fan-out      the fake nested runner: `groups` x `perGroup` workers through
//                nested `runParallel` calls, exiting non-zero if any failed
//   echo         prints one line on stdout and one on stderr
//   exit         exits at once with the given code

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type RunResult, runCommand, runParallel } from '../../lib/exec';

const FIXTURE = import.meta.path;

/** How long a fake waits for a stop that never comes before it gives up. */
const FAKE_LIFETIME_MS = 60_000;

/** The pids a fake child reports once its grandchild is running. */
export interface ReadyPids {
  readonly child: number;
  readonly grandchild: number;
}

/** How a fake reacts to SIGINT and SIGTERM: `linger:<ms>` or `ignore`. */
type StopBehaviour = `linger:${number}` | 'ignore';

/** What the fakes saw, one line per signal: `<role> <signal>`. */
export const SIGNALS_LOG = 'signals.log';

/** One line per worker transition: `<epoch ms> start|end <pid>`. */
export const WORKERS_LOG = 'workers.log';

/** Written by the grandchild once its signal handlers are installed; holds its pid. */
const GRANDCHILD_UP = 'grandchild-up';

/** The file whose existence lets the workers finish. */
export const RELEASE_FILE = 'release';

/** The lines the `echo` role prints, so a test can look for them in the output. */
export const ECHO_STDOUT = 'fake-child says hello on stdout';
export const ECHO_STDERR = 'fake-child says hello on stderr';

/**
 * The command line that runs one role of the fake process tree.
 *
 * @example
 * Bun.spawn(fixtureCommand('runner', dir));
 */
export function fixtureCommand(role: string, dir: string, ...args: string[]): string[] {
  return [process.execPath, FIXTURE, role, dir, ...args];
}

/** True while `pid` names a live process (signal 0 only checks it exists). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The process group `pid` belongs to (POSIX only), read through `ps` because
 * neither Bun nor Node expose `getpgid`.
 *
 * @example
 * processGroupOf(process.pid); // the group the test runner itself is in
 */
export function processGroupOf(pid: number): number {
  const out = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)])
    .stdout.toString()
    .trim();
  const group = Number(out);
  if (!Number.isInteger(group) || group < 1) {
    throw new Error(`expected a process group for pid ${pid} | received: ${JSON.stringify(out)}`);
  }
  return group;
}

/**
 * Polls until `done()` holds or `timeoutMs` passes, and reports whether it held.
 *
 * @example
 * const ready = await waitFor(() => existsSync(file), 5_000);
 */
export async function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await Bun.sleep(25);
  }
  return done();
}

/** The pids the fake child wrote, or `undefined` before it is ready. */
export function readReadyPids(dir: string): ReadyPids | undefined {
  const file = join(dir, 'ready.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ReadyPids;
  } catch {
    // Caught mid-write; the next poll sees the whole file.
    return undefined;
  }
}

/** Kills a pid and ignores that it may already be gone (test cleanup only). */
export function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, which is the state the cleanup wants.
  }
}

/** The grandchild's own pid, once it wrote it (before `ready.json` exists). */
export function readGrandchildPid(dir: string): number | undefined {
  const file = join(dir, GRANDCHILD_UP);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, 'utf8'));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Every worker pid that logged a start, for cleanup after a failed test. */
export function readWorkerPids(dir: string): number[] {
  const file = join(dir, WORKERS_LOG);
  if (!existsSync(file)) return [];
  const pids: number[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [, event, pid] = line.split(' ');
    if (event === 'start' && pid) pids.push(Number(pid));
  }
  return pids;
}

/** Kills a whole process group (POSIX only); a missing group is the wanted state. */
export function forceKillGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Not a group, or already empty.
  }
}

async function runFakeRunner(dir: string, childRole: string, extra: string[]): Promise<number> {
  const interactive = childRole === 'interactive';
  const role = interactive ? 'child' : childRole;
  const result = await runCommand('fake-cargo', fixtureCommand(role, dir, ...extra), {
    stdin: interactive ? 'inherit' : 'ignore',
  });
  return result.exitCode;
}

/**
 * The command that starts the grandchild. On Windows it goes through a `.cmd`
 * shim, as `bunx`, `turbo` and `tsc` do: Bun hands back cmd.exe's pid, and the
 * real worker is cmd.exe's child, a link that Bun's own job object lets break
 * away from the runner's tree.
 */
function grandchildLaunch(dir: string, stop: StopBehaviour): string[] {
  const command = fixtureCommand('grandchild', dir, stop);
  if (process.platform !== 'win32') return command;

  const shim = join(dir, 'grandchild.cmd');
  const quoted = command.map((part) => `"${part}"`).join(' ');
  writeFileSync(shim, `@echo off\r\n${quoted}\r\n`);
  return [shim];
}

async function runFakeChild(
  dir: string,
  childStop: StopBehaviour,
  grandchildStop: StopBehaviour
): Promise<void> {
  recordSignals('child', dir, childStop);
  Bun.spawn(grandchildLaunch(dir, grandchildStop), {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  // Ready means both can take a signal: before its handlers exist a process
  // just dies of one, which would make the delivery counts depend on startup.
  // The grandchild reports its own pid, because the one spawn returns may be
  // a shim's.
  const up = join(dir, GRANDCHILD_UP);
  await waitFor(() => existsSync(up) && readFileSync(up, 'utf8') !== '', FAKE_LIFETIME_MS);
  const ready: ReadyPids = { child: process.pid, grandchild: Number(readFileSync(up, 'utf8')) };
  writeFileSync(join(dir, 'ready.json'), JSON.stringify(ready));
  await Bun.sleep(FAKE_LIFETIME_MS);
}

/** Logs a received signal, then reacts as `stop` says. */
function recordSignals(role: string, dir: string, stop: StopBehaviour): void {
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.on(name, () => {
      appendFileSync(join(dir, SIGNALS_LOG), `${role} ${name}\n`);
      if (stop === 'ignore') return;
      setTimeout(() => process.exit(0), Number(stop.slice('linger:'.length)));
    });
  }
}

function stopBehaviour(raw: string | undefined): StopBehaviour {
  return raw === 'ignore' || raw?.startsWith('linger:') ? (raw as StopBehaviour) : 'linger:300';
}

async function runFakeWorker(dir: string): Promise<void> {
  appendFileSync(join(dir, WORKERS_LOG), `${Date.now()} start ${process.pid}\n`);
  await waitFor(() => existsSync(join(dir, RELEASE_FILE)), FAKE_LIFETIME_MS);
  appendFileSync(join(dir, WORKERS_LOG), `${Date.now()} end ${process.pid}\n`);
}

/** One nested group: `perGroup` workers through their own `runParallel`. */
async function runWorkerGroup(dir: string, perGroup: number): Promise<RunResult> {
  const workers = Array.from(
    { length: perGroup },
    (_, index) => () => runCommand(`worker-${index}`, fixtureCommand('worker', dir))
  );
  const results = await runParallel(workers);
  const failed = results.find((result) => result.exitCode !== 0);
  return { label: 'group', exitCode: failed?.exitCode ?? 0, duration: 0 };
}

async function runFakeFanOut(dir: string, groups: number, perGroup: number): Promise<number> {
  const results = await runParallel(
    Array.from({ length: groups }, () => () => runWorkerGroup(dir, perGroup))
  );
  return results.some((result) => result.exitCode !== 0) ? 1 : 0;
}

if (import.meta.main) {
  const [role, dir = '', ...rest] = process.argv.slice(2);
  const numbers = rest.map(Number);
  if (role === 'runner') process.exit(await runFakeRunner(dir, rest[0] ?? 'child', rest.slice(1)));
  if (role === 'child') await runFakeChild(dir, stopBehaviour(rest[0]), stopBehaviour(rest[1]));
  if (role === 'grandchild') {
    recordSignals('grandchild', dir, stopBehaviour(rest[0]));
    writeFileSync(join(dir, GRANDCHILD_UP), String(process.pid));
    await Bun.sleep(FAKE_LIFETIME_MS);
  }
  if (role === 'worker') await runFakeWorker(dir);
  if (role === 'fan-out') process.exit(await runFakeFanOut(dir, numbers[0] ?? 1, numbers[1] ?? 1));
  if (role === 'echo') {
    console.log(ECHO_STDOUT);
    console.error(ECHO_STDERR);
  }
  if (role === 'exit') process.exit(numbers[0] ?? 0);
}
