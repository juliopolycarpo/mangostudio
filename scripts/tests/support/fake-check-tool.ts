/**
 * A stand-in for the `turbo`, `bunx dprint` and `git` commands Check spawns, compiled by
 * `check-report.unit.test.ts` into native executables named after each tool, so Check's real
 * `PATH` lookup finds them on Windows too.
 *
 * - `turbo` blocks `CHECK_FIXTURE_BLOCK_REPORT` when set, sleeps when
 *   `CHECK_FIXTURE_TURBO_DELAY=yes`, then exits with `CHECK_FIXTURE_TURBO_EXIT`.
 * - `bunx` unblocks `CHECK_FIXTURE_UNBLOCK_REPORT` once Check has failed to publish a snapshot
 *   onto it, then exits with `CHECK_FIXTURE_DPRINT_EXIT`.
 * - `git` blocks `CHECK_FIXTURE_BLOCK_REPORT` and fails with a fixed message.
 *
 * Blocking replaces the report file with a directory, so Check's next rename onto it fails and
 * leaves its temporary file beside it.
 *
 * @example
 * CHECK_FIXTURE_TURBO_EXIT=2 turbo run check --filter=@mangostudio/api
 */
import { mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const UNBLOCK_TIMEOUT_MS = 10_000;

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

function blockReport(report: string): void {
  rmSync(report, { force: true });
  mkdirSync(report);
}

/** Waits for the temporary file a failed rename leaves, then lets later writes through. */
async function unblockAfterFailedSnapshot(report: string): Promise<void> {
  const prefix = `${basename(report)}.`;
  const deadline = Date.now() + UNBLOCK_TIMEOUT_MS;
  while (!readdirSync(dirname(report)).some((name) => name.startsWith(prefix))) {
    if (Date.now() > deadline) {
      throw new Error(
        `fake bunx (unblock): expected a failed snapshot beside ${report} within ${UNBLOCK_TIMEOUT_MS}ms | received: none`
      );
    }
    await Bun.sleep(10);
  }
  rmdirSync(report);
}

const tool = basename(process.execPath).replace(/\.exe$/i, '');
if (tool === 'git') {
  const report = fixtureEnv('CHECK_FIXTURE_BLOCK_REPORT');
  if (!report) {
    throw new Error('fake git (block): expected CHECK_FIXTURE_BLOCK_REPORT | received: unset');
  }
  blockReport(report);
  console.error('fake git failed after blocking the report');
  process.exit(128);
}
if (tool === 'bunx') {
  const report = fixtureEnv('CHECK_FIXTURE_UNBLOCK_REPORT');
  if (report) await unblockAfterFailedSnapshot(report);
  process.exit(exitCodeFrom('CHECK_FIXTURE_DPRINT_EXIT'));
}

const report = fixtureEnv('CHECK_FIXTURE_BLOCK_REPORT');
if (report) blockReport(report);
if (fixtureEnv('CHECK_FIXTURE_TURBO_DELAY') === 'yes') await Bun.sleep(30_000);
process.exit(exitCodeFrom('CHECK_FIXTURE_TURBO_EXIT'));
