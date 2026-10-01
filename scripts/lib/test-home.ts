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
 * `RUSTUP_HOME`, `BUN_INSTALL` and Bun's install cache are pinned to the real
 * ones. `MANGOSTUDIO_RUNTIME_BINARY` and every other inherited variable pass
 * through untouched.
 */

import { constants } from 'node:os';
import { join } from 'node:path';
import {
  createTemporaryHome,
  currentHost,
  homeEnv,
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
    ...homeEnv(root),
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

/** Creates a fresh test home under the OS temp directory. */
function createTestHome(host: TemporaryHomeHost = launcherHost()): string {
  return createTemporaryHome(TEST_HOME_KIND, host);
}

/** Removes a test home, after proving it is one. */
function removeTestHome(root: string, host: TemporaryHomeHost = launcherHost()): void {
  removeTemporaryHome(root, TEST_HOME_KIND, host);
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
const FORWARDED = Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[];

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
 * @example
 * const code = await runWithTestHome(['bun', 'test', 'tests/unit']);
 */
export async function runWithTestHome(
  command: readonly string[],
  ambient: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (command.length === 0) {
    throw new Error('with-test-home: expected a command to run | received: none');
  }
  const host = launcherHost(ambient);
  const root = createTestHome(host);
  const [program, ...args] = command as [string, ...string[]];
  const child = Bun.spawn({
    // The same Bun that runs the launcher, not whatever PATH says next.
    cmd: [program === 'bun' ? process.execPath : program, ...args],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...ambient, ...testHomeEnv(root, ambient, host) },
  });
  const forwarders = FORWARDED.map((name) => {
    const forward = (): void => {
      child.kill(SIGNAL_NUMBERS[name]);
    };
    process.on(name, forward);
    return () => process.off(name, forward);
  });

  try {
    const exitCode = await child.exited;
    return shellExitCode(exitCode, child.signalCode ? signalNumber(child.signalCode) : null);
  } finally {
    for (const detach of forwarders) detach();
    removeHomeQuietly(root, host);
  }
}

/**
 * The number of the signal that ended the child, whichever it was: the watchdog
 * keys its crash retry on 134 (SIGABRT) and triages 137 (SIGKILL, the OOM
 * killer) apart from a hang, so an unforwarded signal must not read as 143.
 * An unknown name reports plain failure.
 */
function signalNumber(name: string): number | null {
  const number = (constants.signals as Record<string, number | undefined>)[name];
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
