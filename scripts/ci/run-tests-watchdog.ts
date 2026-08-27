// Bound a CI test invocation against Bun's isolate-runner hang and retry it
// once.
//
// The failure this exists for is oven-sh/bun#39709 (see also #39584): a
// `bun test` running in isolate mode (`--parallel=N` implies it) sometimes
// never exits — the log freezes and the job burns its whole `timeout-minutes`
// before the runner kills it. `--timeout` bounds a *test*, not the runner
// process, so nothing inside Bun ends the wait. Observed on this repo's shard
// jobs at `--parallel=1` on stock Bun 1.4.0; the upstream fix
// (oven-sh/bun#38008) is unmerged, so until a release carries it this
// watchdog turns a 10-minute stall plus a manual rerun into a bounded retry.
//
// Two details are load-bearing:
//
//   - The child runs as its own process group and the whole group is killed.
//     `bun run test` fans out into turbo -> bun test -> isolate workers, and
//     killing only the direct child leaves wedged grandchildren holding the
//     SQLite file and the runner's process table (observed: the runner's
//     "Cleaning up orphan processes" killing bun/turbo/tee after a hang).
//   - The restored `.mango/artifacts/timings` baseline is snapshotted before
//     the first attempt and put back before the retry. `--update-timings` may
//     have rewritten a lane's file to this shard's slice before the hang, and
//     a retry that balances against different bytes than the other seven
//     shards computes a different partition — files silently run twice or not
//     at all (the disagreement scripts/ci/merge-timings-shards.ts exists to
//     catch).
//
// A run that *fails* is not retried — only one that had to be killed. Real
// failures should surface, not get a second roll of the dice.
//
// Usage: bun ./scripts/ci/run-tests-watchdog.ts --label=3 -- bun run test --coverage --shard=3/8

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { TIMINGS_DIR } from '../lib/test-lanes';

export interface WatchdogOptions {
  /** Shard number or lane name, recorded as `shard` in the meta file. */
  readonly label: string;
  readonly command: readonly string[];
  /** Wall-clock bound per attempt; an attempt still running after it is hung. */
  readonly timeoutSeconds: number;
  /** How long SIGTERM gets before the group is SIGKILLed. */
  readonly killGraceSeconds?: number;
  /** Combined stdout+stderr of the attempt whose exit code is reported. */
  readonly logFile: string;
  /** `shard-meta.json` the merge job reads; written even when hung. */
  readonly metaFile: string;
  /** Timings baseline to snapshot and restore between attempts. */
  readonly timingsDir?: string;
  readonly cwd?: string;
}

export interface WatchdogResult {
  /** 124 when the final attempt hung, mirroring GNU timeout. */
  readonly exitCode: number;
  readonly attempts: number;
  readonly durationSeconds: number;
}

const HUNG_EXIT_CODE = 124;

interface AttemptResult {
  readonly exitCode: number;
  readonly hung: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group can be fully reaped between the timeout firing and this call.
  }
};

const runAttempt = async (options: WatchdogOptions): Promise<AttemptResult> => {
  const [executable, ...args] = options.command;
  if (!executable) throw new Error('Watchdog needs a command after --');

  // Truncated per attempt, not appended: the file feeds the unhandled-error
  // extraction and the failure artifact, and both must describe the attempt
  // whose exit code the job reports — a killed first attempt's partial output
  // would count phantom errors against a green retry. Every attempt is still
  // streamed to stdout, so the job log keeps the full history.
  const log = createWriteStream(options.logFile, { flags: 'w' });
  // detached: the child leads its own process group, so the kill below reaches
  // turbo and the bun test workers it spawned, not just the top process.
  const child = spawn(executable, args, {
    cwd: options.cwd ?? ROOT_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (chunk: Buffer): void => {
    process.stdout.write(chunk);
    log.write(chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? HUNG_EXIT_CODE : 1)));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutSeconds * 1000);
  });

  try {
    const first = await Promise.race([exited, timedOut]);
    if (first !== 'timeout') return { exitCode: first, hung: false };

    const pid = child.pid;
    const graceMs = (options.killGraceSeconds ?? 10) * 1000;
    if (pid !== undefined) {
      killGroup(pid, 'SIGTERM');
      await Promise.race([exited, sleep(graceMs)]);
      killGroup(pid, 'SIGKILL');
      // Direct-child fallback for a platform where the group kill is refused;
      // a no-op when the group kill landed.
      child.kill('SIGKILL');
      // A grandchild that escaped the group cannot be reached from here; do
      // not wait on the pipes closing, only on the direct child's exit.
      await Promise.race([exited, sleep(2000)]);
    }
    return { exitCode: HUNG_EXIT_CODE, hung: true };
  } finally {
    clearTimeout(timer);
    log.end();
  }
};

const snapshotTimings = async (timingsDir: string): Promise<string | null> => {
  const exists = await stat(timingsDir).then(
    (entry) => entry.isDirectory(),
    () => false
  );
  if (!exists) return null;
  const backup = await mkdtemp(join(tmpdir(), 'mango-timings-baseline-'));
  await cp(timingsDir, backup, { recursive: true });
  return backup;
};

const restoreTimings = async (timingsDir: string, backup: string): Promise<void> => {
  await rm(timingsDir, { recursive: true, force: true });
  await cp(backup, timingsDir, { recursive: true });
};

/**
 * Run a test command with a hang watchdog and one retry, and record the
 * shard-meta the merge job reads. The exit code is the final attempt's; a
 * hang reports 124.
 * // Usage: const { exitCode } = await runTestsWithWatchdog({ label: '3', command: ['bun', 'run', 'test'], timeoutSeconds: 240, logFile: 'coverage-run.log', metaFile: 'shard-meta.json' });
 */
export const runTestsWithWatchdog = async (options: WatchdogOptions): Promise<WatchdogResult> => {
  const startedAt = Date.now();
  const timingsDir = options.timingsDir ?? join(options.cwd ?? ROOT_DIR, TIMINGS_DIR);
  const backup = await snapshotTimings(timingsDir);

  let attempts = 1;
  let attempt = await runAttempt(options);
  if (attempt.hung) {
    process.stdout.write(
      `::warning::Test invocation for '${options.label}' produced no exit within ` +
        `${options.timeoutSeconds}s; killed its process group and retrying once ` +
        '(oven-sh/bun#39709 — Bun isolate runner hang).\n'
    );
    if (backup) await restoreTimings(timingsDir, backup);
    attempts = 2;
    attempt = await runAttempt(options);
  }
  if (backup) await rm(backup, { recursive: true, force: true });

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const shard = /^\d+$/.test(options.label) ? Number(options.label) : options.label;
  await Bun.write(
    options.metaFile,
    `${JSON.stringify({ shard, exitCode: attempt.exitCode, durationSeconds })}\n`
  );
  return { exitCode: attempt.exitCode, attempts, durationSeconds };
};

const USAGE =
  'Usage: bun ./scripts/ci/run-tests-watchdog.ts --label=<shard|lane> ' +
  '[--timeout-seconds=240] [--log-file=coverage-run.log] [--meta-file=shard-meta.json] -- <command...>\n';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);

  let label: string | null = null;
  let timeoutSeconds = 240;
  let logFile = 'coverage-run.log';
  let metaFile = 'shard-meta.json';
  let valid = true;
  for (const flag of flags) {
    if (flag.startsWith('--label=')) label = flag.slice('--label='.length);
    else if (flag.startsWith('--timeout-seconds=')) {
      timeoutSeconds = Number(flag.slice('--timeout-seconds='.length));
    } else if (flag.startsWith('--log-file=')) logFile = flag.slice('--log-file='.length);
    else if (flag.startsWith('--meta-file=')) metaFile = flag.slice('--meta-file='.length);
    else valid = false;
  }

  if (!valid || !label || command.length === 0 || !Number.isFinite(timeoutSeconds)) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const result = await runTestsWithWatchdog({
    label,
    command,
    timeoutSeconds,
    logFile,
    metaFile,
    cwd: process.cwd(),
  });
  process.exit(result.exitCode);
}
