/**
 * A stand-in for the `turbo` and `bunx dprint` commands Check spawns, compiled by
 * `check-report.unit.test.ts` into native executables named after each tool, so Check's real
 * `PATH` lookup finds them on Windows too.
 *
 * - `turbo` locks `CHECK_FIXTURE_LOCK_DIR` when set, sleeps when
 *   `CHECK_FIXTURE_TURBO_DELAY=yes`, then exits with `CHECK_FIXTURE_TURBO_EXIT`.
 * - `bunx` exits with `CHECK_FIXTURE_DPRINT_EXIT`.
 *
 * @example
 * CHECK_FIXTURE_TURBO_EXIT=2 turbo run check --filter=@mangostudio/api
 */
import { chmodSync } from 'node:fs';
import { basename } from 'node:path';

/** Reads a variable the test sets on Check's environment; none is a Turbo task input. */
function fixtureEnv(name: string): string | undefined {
  return process.env[name];
}

function exitCodeFrom(name: string): number {
  const value = fixtureEnv(name);
  const exitCode = Number(value);
  if (!value || !Number.isInteger(exitCode)) {
    throw new Error(
      `fake check tool (${name}): expected an integer exit code | received: ${JSON.stringify(value)}`
    );
  }
  return exitCode;
}

const tool = basename(process.execPath).replace(/\.exe$/i, '');
if (tool === 'bunx') process.exit(exitCodeFrom('CHECK_FIXTURE_DPRINT_EXIT'));

const lockDirectory = fixtureEnv('CHECK_FIXTURE_LOCK_DIR');
if (lockDirectory) chmodSync(lockDirectory, 0o500);
if (fixtureEnv('CHECK_FIXTURE_TURBO_DELAY') === 'yes') await Bun.sleep(30_000);
process.exit(exitCodeFrom('CHECK_FIXTURE_TURBO_EXIT'));
