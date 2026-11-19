/**
 * Runs a test command with a throwaway home, so the tests under it can neither
 * read nor write the developer's real `~/.mango`, `~/.claude` or anything else
 * `homedir()` leads to.
 *
 * The home has to be set by the process that STARTS the tests: Bun honours
 * `HOME` at start-up and ignores a later assignment to `process.env.HOME`, so a
 * preload or a test cannot redirect `homedir()` itself. The API workspace's
 * `test:*` scripts therefore start `bun test` through `scripts/with-test-home.ts`,
 * which is the one place this module is used from.
 *
 * Moving `HOME` also hides what the toolchain finds there, so `CARGO_HOME`,
 * `RUSTUP_HOME`, `BUN_INSTALL`, Bun's install cache
 * are pinned to the real ones. `MANGOSTUDIO_RUNTIME_BINARY` and every other
 * inherited variable except the standard home/storage roots pass through untouched.
 *
 * The launcher also gives the tests a temp directory of their own (`TMPDIR`,
 * `TMP`, `TEMP`), removes it afterwards, and fails a run that exited 0 but left
 * entries in it, naming them. A test that forgets to remove a directory it made
 * therefore fails its lane instead of filling the machine's `/tmp` over days, and
 * a process killed before it could clean up still leaves nothing behind.
 */

import { readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, join } from 'node:path';

import {
  createTemporaryHome,
  currentHost,
  fixtureHomeEnv,
  removeTemporaryHome,
  type TemporaryHomeHost,
  type TemporaryHomeKind,
  toolchainEnv,
} from './temp-home';

/**
 * Carries the launcher's original home to the test process, so a preload can
 * tell that the launcher's `HOME` never took effect. Set only when absent, so a
 * launcher started inside another one keeps the genuinely real home.
 */
export const REAL_HOME_ENV = 'MANGOSTUDIO_REAL_HOME';

/** Prefix of every directory {@link createTestHome} creates. */
export const TEST_HOME_PREFIX = 'mangostudio-test-home-';

/** Names the test home for the shared shape check and its error messages. */
export const TEST_HOME_KIND: TemporaryHomeKind = {
  prefix: TEST_HOME_PREFIX,
  context: 'api-tests',
  noun: 'test home',
};

/**
 * The real home and temp directory, honouring a home an outer launcher already
 * recorded in {@link REAL_HOME_ENV} over this process's own (already moved) one.
 *
 * @example
 * launcherHost({ MANGOSTUDIO_REAL_HOME: '/home/me' }).realHome; // => '/home/me'
 */
export function launcherHost(
  env: NodeJS.ProcessEnv = process.env,
  base: TemporaryHomeHost = currentHost()
): TemporaryHomeHost {
  const recorded = env[REAL_HOME_ENV]?.trim();
  return recorded ? { ...base, realHome: recorded } : base;
}

/**
 * The environment a test process starts with: the temporary home, the original
 * home for the preload's comparison, and the toolchain homes pinned to the real
 * ones.
 *
 * @example
 * testHomeEnv('/tmp/mangostudio-test-home-a1b2c3', process.env).HOME;
 * // => '/tmp/mangostudio-test-home-a1b2c3'
 */
export function testHomeEnv(
  root: string,
  ambient: NodeJS.ProcessEnv = process.env,
  host: TemporaryHomeHost = launcherHost(ambient)
): Record<string, string> {
  const bunInstall = ambient.BUN_INSTALL?.trim() || join(host.realHome, '.bun');
  return {
    ...fixtureHomeEnv(root),
    // `$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config` both resolve from
    // variables the developer may have exported, so name the global config
    // outright. The file does not exist, which Git reads as empty: no signing
    // policy, identity, hooks path or credential helper of the developer's
    // reaches the repositories the tests build, and a `--global` write a test
    // makes lands inside the temporary home. A PATH wrapper that enforces
    // signing stands down for a harness that discards the user configuration
    // this way, which is what a CI runner looks like to it.
    GIT_CONFIG_GLOBAL: join(root, '.gitconfig'),
    [REAL_HOME_ENV]: host.realHome,
    ...toolchainEnv(ambient, host),
    BUN_INSTALL: bunInstall,
    BUN_INSTALL_CACHE_DIR:
      ambient.BUN_INSTALL_CACHE_DIR?.trim() || join(bunInstall, 'install', 'cache'),
  };
}

/**
 * The whole environment a launched lane starts with: the ambient one, moved to
 * the temporary home, without `VERSION`.
 *
 * `getVersion()` reads `VERSION`, which a release build stamps. A shell that
 * left it exported after building a release hub would make every lane a
 * release-build run: the hub refuses the source-built Local runtime as another
 * release, doctor reports drift against its fixture runtime, and a peer at the
 * exported version is offered no live update. The lanes are written for a dev
 * build, and a test that needs a release version sets it itself. Only the lanes
 * go through this launcher; a release job that runs one test file on purpose
 * with `VERSION` set (the container smoke) calls `bun test` directly and keeps
 * it.
 *
 * @example
 * testChildEnv('/tmp/mangostudio-test-home-a1b2c3', { VERSION: '1.2.3', PATH: '/bin' }).VERSION;
 * // => undefined
 */
export function testChildEnv(
  root: string,
  ambient: NodeJS.ProcessEnv = process.env,
  host: TemporaryHomeHost = launcherHost(ambient)
): NodeJS.ProcessEnv {
  const { VERSION: _inheritedBuildVersion, ...rest } = ambient;
  return { ...rest, ...testHomeEnv(root, ambient, host) };
}

/** Prefix of every directory {@link createTestTemp} creates. */
export const TEST_TMP_PREFIX = 'mangostudio-test-tmp-';

/** Names the per-run temp directory for the shared shape check and its error messages. */
const TEST_TMP_KIND: TemporaryHomeKind = {
  prefix: TEST_TMP_PREFIX,
  context: 'api-tests',
  noun: 'test temp directory',
};

/**
 * Points every way a process finds the OS temp directory at `root`: `TMPDIR`
 * for POSIX and Rust's `std::env::temp_dir`, `TMP`/`TEMP` for Windows.
 *
 * @example
 * testTempEnv('/tmp/mangostudio-test-tmp-a1b2c3').TMPDIR; // => '/tmp/mangostudio-test-tmp-a1b2c3'
 */
export function testTempEnv(root: string): Record<string, string> {
  return { TMPDIR: root, TMP: root, TEMP: root };
}

/**
 * The entries a run left in its temp directory, sorted. Every test that made
 * one was meant to remove it, so each name is a leak.
 *
 * @example
 * listTempLeftovers('/tmp/mangostudio-test-tmp-a1b2c3'); // => ['skills-doctor-x1y2z3']
 */
export function listTempLeftovers(root: string): string[] {
  return readdirSync(root).sort();
}

/**
 * The message for a run that left entries behind, naming each one.
 *
 * @example
 * describeTempLeak('/tmp/t', ['a-1', 'a-2']);
 * // => 'with-test-home: tests left 2 entries in their temp directory /tmp/t | expected: none | received: a-1, a-2. Create ...'
 */
export function describeTempLeak(root: string, names: readonly string[]): string {
  const shown = names.slice(0, MAX_LEAKS_SHOWN).join(', ');
  const more = names.length > MAX_LEAKS_SHOWN ? `, … (${names.length - MAX_LEAKS_SHOWN} more)` : '';
  return (
    `with-test-home: tests left ${names.length} ${names.length === 1 ? 'entry' : 'entries'} in their temp directory ` +
    `${root} | expected: none | received: ${shown}${more}. ` +
    'Create temporary directories through useScratchDirs() (scripts/tests/support/scratch-dirs.ts) or remove them in afterEach/afterAll.'
  );
}

/** How many leaked names the message lists before it counts the rest. */
const MAX_LEAKS_SHOWN = 20;

/** Creates a fresh test home under the OS temp directory. */
function createTestHome(host: TemporaryHomeHost = launcherHost()): string {
  return createTemporaryHome(TEST_HOME_KIND, host);
}

/** Removes a test home, after proving it is one. */
function removeTestHome(root: string, host: TemporaryHomeHost = launcherHost()): void {
  removeTemporaryHome(root, TEST_HOME_KIND, host);
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
/** The last Linux real-time signal; no child reports a number above it. */
const MAX_SIGNAL_NUMBER = 64;
const FORWARDED = Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[];

/** The child status and signal operations the temporary-home launcher owns. */
export interface TestHomeChild {
  readonly exited: Promise<number>;
  readonly signalCode: string | number | null;
  kill(signal: number): unknown;
}

/** Native spawn by default; replace external process I/O in launcher tests. */
export interface TestHomeDependencies {
  readonly spawn: (command: readonly string[], env: NodeJS.ProcessEnv) => TestHomeChild;
}

function spawnTestChild(command: readonly string[], env: NodeJS.ProcessEnv): TestHomeChild {
  return Bun.spawn({
    cmd: [...command],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env,
  });
}

/**
 * The exit code a shell would report: the child's own, or 128 plus the signal
 * that ended it. The watchdog and the coverage orchestrator read this.
 *
 * @example
 * shellExitCode(null, 15); // => 143
 */
export function shellExitCode(exitCode: number | null, signal: number | null): number {
  if (signal) return 128 + signal;
  return exitCode ?? 1;
}

/**
 * Runs `command` with stdio inherited and a fresh test home, removes the home
 * when the command ends, and returns the exit code to report.
 *
 * Termination signals are forwarded to the child instead of ending this
 * process, so the home is still removed after an interrupted run.
 *
 * The child also gets a temp directory of its own (`TMPDIR`, `TMP`, `TEMP`),
 * which holds the home and is removed with it. A run that exits 0 but left
 * another entry there is reported as a failure naming the entry, so a test
 * that forgets to remove its `mkdtemp` directory fails its lane.
 *
 * @example
 * const code = await runWithTestHome(['bun', 'test', 'tests/unit']);
 */
export async function runWithTestHome(
  command: readonly string[],
  ambient: NodeJS.ProcessEnv = process.env,
  dependencies: TestHomeDependencies = { spawn: spawnTestChild }
): Promise<number> {
  if (command.length === 0) {
    throw new Error('with-test-home: expected a command to run | received: none');
  }
  const host = launcherHost(ambient);
  // The home lives inside the temp directory, not beside it: the lane's own
  // shape check wants the home to be a direct child of the temp directory the
  // lane sees, and a test that asserts its temp directory is outside the home
  // keeps passing (the temp directory is the home's parent, not its child).
  const tempRoot = createTemporaryHome(TEST_TMP_KIND, host);
  const tempHost = { ...host, tmpDir: tempRoot };
  let root: string | undefined;
  const [program, ...args] = command as [string, ...string[]];
  const forwarders: (() => void)[] = [];
  try {
    root = createTestHome(tempHost);
    const child = dependencies.spawn(
      // The same Bun that runs the launcher, not whatever PATH says next.
      [program === 'bun' ? process.execPath : program, ...args],
      { ...testChildEnv(root, ambient, host), ...testTempEnv(tempRoot) }
    );
    for (const name of FORWARDED) {
      const forward = (): void => {
        child.kill(SIGNAL_NUMBERS[name]);
      };
      process.on(name, forward);
      forwarders.push(() => process.off(name, forward));
    }
    const exitCode = await child.exited;
    const code = shellExitCode(exitCode, child.signalCode ? signalNumber(child.signalCode) : null);
    return reportTempLeaks(tempRoot, basename(root), code);
  } finally {
    for (const detach of forwarders) detach();
    if (root) removeHomeQuietly(root, tempHost);
    removeTempQuietly(tempRoot, host);
  }
}

/**
 * Fails a run that exited 0 but left entries in its temp directory, and names
 * them. A run that already failed keeps its own code (the watchdog reads it),
 * but its leftovers are listed too, so the cause is not hidden behind it.
 */
function reportTempLeaks(tempRoot: string, homeName: string, code: number): number {
  const leftovers = listTempLeftovers(tempRoot).filter((name) => name !== homeName);
  if (leftovers.length === 0) return code;
  process.stderr.write(`${describeTempLeak(tempRoot, leftovers)}\n`);
  return code === 0 ? 1 : code;
}

/**
 * The number of the signal that ended the child, whichever it was: the watchdog
 * keys its crash retry on 134 (SIGABRT) and triages 137 (SIGKILL, the OOM
 * killer) apart from a hang, so an unforwarded signal must not read as 143.
 * A number from 1 to 64 (Linux stops at its last real-time signal) passes
 * through. Any other number, like an unknown name, reports plain failure: 128
 * plus it would exceed 255 and `process.exit` would wrap it to a passing code.
 */
function signalNumber(signal: string | number): number | null {
  if (typeof signal === 'number') {
    return Number.isInteger(signal) && signal >= 1 && signal <= MAX_SIGNAL_NUMBER ? signal : null;
  }
  const number = (constants.signals as Record<string, number | undefined>)[signal];
  return typeof number === 'number' ? number : null;
}

function removeHomeQuietly(root: string, host: TemporaryHomeHost): void {
  try {
    removeTestHome(root, host);
  } catch (caught) {
    // A leftover directory must not turn a green run red or hide its exit code.
    const reason = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`with-test-home: could not remove ${root}: ${reason}\n`);
  }
}

function removeTempQuietly(root: string, host: TemporaryHomeHost): void {
  try {
    removeTemporaryHome(root, TEST_TMP_KIND, host);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`with-test-home: could not remove ${root}: ${reason}\n`);
  }
}
