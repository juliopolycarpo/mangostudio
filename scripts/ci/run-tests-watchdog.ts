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
// `retryOnCrash` (opt-in, unset for every merge-gate caller) extends the same
// bound to a second failure class: the isolate runner aborting outright
// (`panic(main thread): abort()`, the #889 class of oven-sh/bun#39709) rather
// than hanging. A crash truncates whatever file list was left, so it gets the
// same one same-seed retry as a hang — and, since the point is not losing a
// night's findings, the attempt log a crash would otherwise clobber is kept
// alongside the retry's instead of overwritten.
//
// Usage: bun ./scripts/ci/run-tests-watchdog.ts --label=3 -- bun run test --coverage --shard=3/8

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { appendFile, cp, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { normalizeLogLine } from '../lib/log-lines';
import { TIMINGS_DIR } from '../lib/test-lanes';

export interface WatchdogOptions {
  /** Shard number or lane name, recorded as `shard` in the meta file. */
  readonly label: string;
  readonly command: readonly string[];
  /** Wall-clock bound per attempt; an attempt still running after it is hung. */
  readonly timeoutSeconds: number;
  /** How long SIGTERM gets before the group is SIGKILLed. */
  readonly killGraceSeconds?: number;
  /**
   * How long a crashed attempt's reaped process group gets to finish before
   * the retry starts. Injectable for the same reason `killGraceSeconds` is:
   * the crash-path tests would otherwise each pay the full CI-sized wait.
   */
  readonly crashReapGraceSeconds?: number;
  /** Combined stdout+stderr of the attempt whose exit code is reported. */
  readonly logFile: string;
  /**
   * Where the child's output is mirrored live. Defaults to this process's own
   * stdout — the CI job log. A parameter so tests can assert what was
   * forwarded, and drive the backpressure path, without a dump into the test
   * log.
   */
  readonly stdout?: NodeJS.WritableStream;
  /** `shard-meta.json` the merge job reads; written even when hung. */
  readonly metaFile: string;
  /**
   * Timings baseline to snapshot and restore between attempts. Defaults to
   * the repo-root `TIMINGS_DIR`, which is where every lane's baseline lives
   * regardless of the directory the caller's step runs from.
   */
  readonly timingsDir?: string;
  readonly cwd?: string;
  /**
   * Retry once, same seed, when a non-hung attempt looks like an isolate-runner
   * abort rather than a real test failure (SIGABRT/134, or a crash marker in
   * the log). Off by default — every existing caller keeps the old
   * fail-once-and-surface contract.
   */
  readonly retryOnCrash?: boolean;
  /**
   * Before a retry, rename the first attempt's log to `<logFile>.attempt-1`
   * instead of letting the retry's `createWriteStream('w')` overwrite it. The
   * nightly's whole reason to run under this watchdog is that attempt 1 may
   * hold the night's only ordering finding when a crash cuts it off.
   */
  readonly preserveAttemptLogs?: boolean;
}

export interface WatchdogResult {
  /** 124 when the final attempt hung, mirroring GNU timeout. */
  readonly exitCode: number;
  readonly attempts: number;
  readonly durationSeconds: number;
}

const HUNG_EXIT_CODE = 124;
// SIGABRT via signalExitCode (128 + 6) — also the code Bun's own
// `panic(main thread): abort()` exits with directly, so a literal 134 is
// checked the same way as a signal-derived one.
const CRASH_EXIT_CODE = 134;
const CRASH_LOG_MARKERS = [/oh no: Bun has crashed/, /panic\(main thread\)/];
// Bun reports a failing test twice, and the scan needs both shapes.
//
//   - Inline, the moment it fails: `(fail) suite > name [0.37ms]`.
//   - Once more in the run summary, at the end: ` 2 fail`.
//
// The summary alone is not enough. A crash that struck mid-run never reaches
// it, and that truncated attempt is exactly the one whose findings this scan
// exists to keep — without the inline shape, a crash at file 60 of 101 lets a
// clean retry report green over real failures from files 1-59.
//
// The summary shape is still scanned because it is the only one that survives
// a reporter change, and it is cheap. Both run over the complete log rather
// than a tail slice: a full panic dump (version, features, stack) can trail
// the summary by well over 200 lines.
//
// `[1-9]\d*`, not `\d+`: Bun always prints a ` 0 fail` line on a clean run,
// and `\d+` matches that zero — verified live, it turned a green shared-lane
// run into a reported exit 1.
//
// The same scan must keep Bun's unhandled-error signal. An error raised
// between tests prints `# Unhandled error between tests` and a `N error(s)`
// summary with no failing testcase — `scripts/qa-gate/unhandled-errors.ts`
// exists because JUnit reports `failures="0"` for that run. Without these
// shapes, a crash after only that signal leaves `failuresSeen` false and a
// clean retry reports green over the ordering finding.
const INLINE_FAILURE_RE = /^\(fail\)/;
const FAILURE_SUMMARY_RE = /^[1-9]\d* fail\b/;
const UNHANDLED_HEADING = '# Unhandled error between tests';
const UNHANDLED_ERROR_COUNT_RE = /^[1-9]\d* errors?\b/;

interface AttemptResult {
  readonly exitCode: number;
  readonly hung: boolean;
  /** The attempt's direct child, for reaping stragglers before a retry. */
  readonly pid?: number;
}

/**
 * Whether an attempt died of an isolate-runner abort rather than reporting
 * test results.
 *
 * `CRASH_EXIT_CODE` is decisive on its own. The log markers are the fallback
 * for a crash whose exit code got laundered on the way out — `bun run test`
 * goes through turbo, which reports its own code for the task it ran — so they
 * cannot be dropped, and exit 1 cannot be excluded.
 *
 * What they must not do is classify a *green* run whose output merely quotes
 * those strings, which is not hypothetical: this repo's own watchdog fixtures
 * print both markers, and `bun test scripts/` mirrors them into the parent's
 * stdout. Hence the non-zero gate — without it, adding `--retry-on-crash` to
 * the shard job would make every shard carrying the scripts lane retry itself
 * and report `crashed=true` on a passing run.
 * // Usage: isCrash({ exitCode: 1, hung: false }, 'panic(main thread): abort()') // → true
 */
const isCrash = (attempt: AttemptResult, logText: string): boolean =>
  attempt.exitCode === CRASH_EXIT_CODE ||
  (attempt.exitCode !== 0 && CRASH_LOG_MARKERS.some((marker) => marker.test(logText)));

/**
 * Whether an attempt's log reports a test failure or an unhandled error.
 *
 * Line-wise via `normalizeLogLine` rather than a multiline regex over the raw
 * text: `bun run test` goes through turbo `--ui=stream`, which prefixes every
 * line with `<package>:<task>: `, so a `^`-anchored scan of the raw log
 * matches nothing at all under that caller — silently, and in the direction
 * that reads as green.
 * // Usage: hasFailure('@mangostudio/api:test:  2 fail\n') // → true
 */
const hasFailure = (logText: string): boolean =>
  logText.split('\n').some((rawLine) => {
    const { body } = normalizeLogLine(rawLine);
    return (
      INLINE_FAILURE_RE.test(body) ||
      FAILURE_SUMMARY_RE.test(body) ||
      body === UNHANDLED_HEADING ||
      UNHANDLED_ERROR_COUNT_RE.test(body)
    );
  });

/**
 * Rename attempt 1's log out of the retry's way. `logFile` usually exists
 * here — `runAttempt`'s `finally` waits for the write stream's `finish`
 * before returning — but a `createWriteStream` that never opened (a full
 * disk, a missing directory) leaves nothing to rename. Returns whether the
 * preserved log actually landed on disk. Never throws: a preservation
 * failure must not cancel the retry it is meant to be a safety net for.
 */
const preserveAttemptLog = async (
  logFile: string,
  mirror: NodeJS.WritableStream
): Promise<boolean> => {
  try {
    await rename(logFile, `${logFile}.attempt-1`);
    return true;
  } catch (caught) {
    mirror.write(
      `Watchdog could not preserve ${logFile} before retrying: ${(caught as Error).message}\n`
    );
    return false;
  }
};

// Deliberately ref'd: these are `Promise.race` deadlines, and an unref'd timer
// that is the only thing left pending would let the process exit with a
// still-unresolved race — a silent exit 0 in place of the shard's real code.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The exit code to report for a child the *runner* killed. Deliberately not
 * `HUNG_EXIT_CODE`: 124 means "this watchdog's timer fired", and a shard that
 * the kernel OOM-killed (137) or that segfaulted must not read as a Bun hang
 * in `shard-meta.json` — the two get triaged differently.
 * // Usage: signalExitCode('SIGKILL') // → 137
 */
const signalExitCode = (signal: NodeJS.Signals): number => {
  const number = constants.signals[signal as keyof typeof constants.signals];
  return typeof number === 'number' ? 128 + number : 1;
};

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
  const mirror = options.stdout ?? process.stdout;
  // detached: the child leads its own process group, so the kill below reaches
  // turbo and the bun test workers it spawned, not just the top process.
  const child = spawn(executable, args, {
    cwd: options.cwd ?? ROOT_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Neither sink is guaranteed to take a chunk synchronously: a CI stdout pipe
  // and a log file both refuse once their buffer fills. A forwarder that
  // ignores `write`'s return value never pauses the child, so the unflushed
  // chunks pile up on the watchdog's heap for the length of the run — with
  // MANGOSTUDIO_SPAWN_DIAGNOSTICS on top of the test output, that is the whole
  // shard. The `2>&1 | tee` shape this replaced got the backpressure from the
  // pipe for free.
  const blocked = new Set<NodeJS.WritableStream>();
  const resumeIfDrained = (): void => {
    if (blocked.size > 0) return;
    child.stdout.resume();
    child.stderr.resume();
  };
  const writeTo = (sink: NodeJS.WritableStream, chunk: Buffer): void => {
    if (sink.write(chunk) || blocked.has(sink)) return;
    blocked.add(sink);
    child.stdout.pause();
    child.stderr.pause();
    sink.once('drain', () => {
      blocked.delete(sink);
      resumeIfDrained();
    });
  };

  // A write stream with nothing on `error` throws on the first failed write.
  // The log is a diagnostic, never the run's verdict, so a full disk must not
  // turn a green shard into a crashed watchdog — and must not leave the child
  // paused on a sink that will never emit `drain` either, which would starve it
  // until the timeout fired and reported a Bun hang that never happened.
  let logWritable = true;
  log.on('error', (caught: Error) => {
    logWritable = false;
    blocked.delete(log);
    resumeIfDrained();
    mirror.write(`Watchdog could not write ${options.logFile}: ${caught.message}\n`);
  });

  const forward = (chunk: Buffer): void => {
    writeTo(mirror, chunk);
    if (logWritable) writeTo(log, chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? signalExitCode(signal) : 1)));
    // Without this listener a spawn failure (a missing executable, EMFILE)
    // emits `error` with nothing subscribed, which Node throws — the watchdog
    // would die before writing `shard-meta.json`, and the merge job would read
    // a missing file rather than a failing shard. `exit` is not guaranteed to
    // follow `error`, so this is also what keeps a command that never started
    // from burning both attempts' full timeouts.
    child.once('error', (caught: Error) => {
      const message = `Watchdog could not run '${options.command.join(' ')}': ${caught.message}\n`;
      mirror.write(message);
      if (logWritable) log.write(message);
      resolve(1);
    });
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutSeconds * 1000);
  });

  try {
    const first = await Promise.race([exited, timedOut]);
    if (first !== 'timeout') return { exitCode: first, hung: false, pid: child.pid };

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
    // `end()` only queues the flush, and the CLI below finishes with
    // `process.exit()`, which does not drain a pending stream. The log feeds
    // the unhandled-error extraction and the failure artifact — and its last
    // line is what names the file that wedged — so wait for the bytes to
    // land. Bounded, because a stream that already errored never emits
    // `finish` and this must not become a second way to hang.
    log.end();
    await Promise.race([once(log, 'finish').catch(() => undefined), sleep(5000)]);
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

/**
 * Put the baseline the first attempt started from back on disk. `backup` is
 * null when there was no baseline — a cold timings cache — and "absent" is
 * then the state to restore, not a no-op: the killed attempt's
 * `--update-timings` leaves this shard's partial slices behind, and a retry
 * that balances against them derives a different partition than the seven
 * shards still falling back to the round-robin split.
 */
const restoreTimings = async (timingsDir: string, backup: string | null): Promise<void> => {
  await rm(timingsDir, { recursive: true, force: true });
  if (backup) await cp(backup, timingsDir, { recursive: true });
};

/**
 * Run a test command with a hang watchdog and one retry, and record the
 * shard-meta the merge job reads. The exit code is the final attempt's — a
 * hang reports 124, and with `retryOnCrash` on, a clean retry after findings
 * elsewhere still reports non-zero (see below).
 * // Usage: const { exitCode } = await runTestsWithWatchdog({ label: '3', command: ['bun', 'run', 'test'], timeoutSeconds: 240, logFile: 'coverage-run.log', metaFile: 'shard-meta.json' });
 */
export const runTestsWithWatchdog = async (options: WatchdogOptions): Promise<WatchdogResult> => {
  const startedAt = Date.now();
  // Anchored at the repo root, not at `cwd`. `TIMINGS_DIR` is a repo-root
  // path (scripts/test.ts creates it there), while `cwd` is wherever the
  // caller's step happens to run — the randomized-order nightly runs its
  // lanes from `apps/<workspace>`, where the old join resolved to an
  // `apps/api/.mango/artifacts/timings` that never exists, making the
  // snapshot/restore invariant a silent no-op.
  const timingsDir = options.timingsDir ?? join(ROOT_DIR, TIMINGS_DIR);
  const backup = await snapshotTimings(timingsDir);
  const crashRetryEnabled = options.retryOnCrash === true;
  const mirror = options.stdout ?? process.stdout;

  let attempts = 1;
  let attempt = await runAttempt(options);
  let crashedAny = false;
  let failuresSeen = false;
  let logPreserved = false;

  /**
   * Classify a finished attempt from its log, and record what it saw.
   *
   * Reads the log while it still sits at `options.logFile` — before any retry
   * renames it out of the way — so both the crash check and the failure scan
   * see the bytes that attempt actually produced. Returns false whenever crash
   * retry is off, which is what keeps every merge-gate caller on the old
   * fail-once-and-surface contract.
   *
   * An attempt that exited 0 is skipped outright, and that gate is what makes
   * the failure scan safe to run on *every* attempt rather than only the
   * aborted one. Bun cannot exit 0 with a failing test, so every `(fail)` or
   * ` N fail` line in a green attempt's log is mirrored data — a suite quoting
   * those strings, which this repo's own fixtures do. Recording it would let a
   * clean retry flip its own exit 0 to 1 over output that reported nothing. A
   * hang (124) and a crash (134, or non-zero with a marker) are both non-zero,
   * so nothing the scan exists for is skipped; a green run just stops paying
   * for a full log read it could not act on.
   */
  const observe = async (result: AttemptResult): Promise<boolean> => {
    if (!crashRetryEnabled || result.exitCode === 0) return false;
    const text = await Bun.file(options.logFile)
      .text()
      .catch(() => '');
    if (hasFailure(text)) failuresSeen = true;
    const crashed = !result.hung && isCrash(result, text);
    crashedAny ||= crashed;
    return crashed;
  };

  const retry = async (): Promise<AttemptResult> => {
    if (options.preserveAttemptLogs) {
      logPreserved = await preserveAttemptLog(options.logFile, mirror);
    }
    await restoreTimings(timingsDir, backup);
    attempts = 2;
    return runAttempt(options);
  };

  let crashed = await observe(attempt);

  if (attempt.hung) {
    // Leading newline, not cosmetic: GitHub parses a workflow command only
    // when `::` starts a line, and a killed child's last chunk routinely ends
    // mid-line — without it the annotation is swallowed into that line.
    mirror.write(
      `\n::warning::Test invocation for '${options.label}' produced no exit within ` +
        `${options.timeoutSeconds}s; killed its process group and retrying once ` +
        '(oven-sh/bun#39709 — Bun isolate runner hang).\n'
    );
    attempt = await retry();
    crashed = await observe(attempt);
  } else if (crashed) {
    mirror.write(
      `\n::warning::Test invocation for '${options.label}' crashed (Bun isolate-runner ` +
        'abort, oven-sh/bun#39709 class — tracked in #889); retrying once with the same seed.\n'
    );
    // The direct child's own abort does not guarantee its isolate workers
    // exited too — an escaped worker would keep running against the same
    // database and inherited output pipes alongside attempt 2. Reap the
    // group and give any straggler a moment to finish before the log is
    // renamed out of the retry's way.
    if (attempt.pid !== undefined) {
      killGroup(attempt.pid, 'SIGKILL');
      await sleep((options.crashReapGraceSeconds ?? 2) * 1000);
    }
    attempt = await retry();
    crashed = await observe(attempt);
  }
  if (backup) await rm(backup, { recursive: true, force: true });

  // A crash that struck after real findings must not read as green just
  // because the retry came back clean — the retry proves the isolate runner
  // recovered, not that the earlier failures didn't happen. `1` rather than
  // the crashed attempt's own code: a plain `bun test` failure is never
  // retried, so the only way in here is a hang (124) or a crash (134/marker),
  // neither of which is a meaningful "test failure" exit code to persist.
  //
  // Two gates make that safe to key off a log scan, and both are needed. Bun
  // cannot exit 0 with a failing test, so a green attempt's matching lines are
  // always a mirror of someone else's output — a suite that prints `(fail)` or
  // ` 2 fail` as *data*, which the watchdog's own fixtures below do. `observe`
  // therefore never records a green attempt at all, which covers the retry
  // itself; `attempts === 2` covers the single-attempt case, where there is no
  // earlier attempt whose findings a clean run could be hiding.
  let exitCode = attempt.exitCode;
  if (crashRetryEnabled && attempts === 2 && failuresSeen && exitCode === 0) exitCode = 1;

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const shard = /^\d+$/.test(options.label) ? Number(options.label) : options.label;
  await Bun.write(options.metaFile, `${JSON.stringify({ shard, exitCode, durationSeconds })}\n`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    if (crashRetryEnabled) await appendFile(githubOutput, `crashed=${crashedAny}\n`);
    // Separate from `crashed`: a hung attempt that retries clean also leaves
    // an `.attempt-1` log on disk, and the caller needs to know to upload it
    // even though `crashedAny` never went true for a plain hang.
    if (options.preserveAttemptLogs) {
      await appendFile(githubOutput, `log-preserved=${logPreserved}\n`);
    }
  }

  return { exitCode, attempts, durationSeconds };
};

const USAGE =
  'Usage: bun ./scripts/ci/run-tests-watchdog.ts --label=<shard|lane> ' +
  '[--timeout-seconds=240] [--log-file=coverage-run.log] [--meta-file=shard-meta.json] ' +
  '[--retry-on-crash] -- <command...>\n';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);

  let label: string | null = null;
  let timeoutSeconds = 240;
  let logFile = 'coverage-run.log';
  let metaFile = 'shard-meta.json';
  let retryOnCrash = false;
  let valid = true;
  for (const flag of flags) {
    if (flag.startsWith('--label=')) label = flag.slice('--label='.length);
    else if (flag.startsWith('--timeout-seconds=')) {
      timeoutSeconds = Number(flag.slice('--timeout-seconds='.length));
    } else if (flag.startsWith('--log-file=')) logFile = flag.slice('--log-file='.length);
    else if (flag.startsWith('--meta-file=')) metaFile = flag.slice('--meta-file='.length);
    else if (flag === '--retry-on-crash') retryOnCrash = true;
    else valid = false;
  }

  // `> 0`, not just finite: a zero or negative bound fires the timer before the
  // child can produce anything, so every attempt reads as hung and the step
  // reports 124 without ever having run the suite.
  const boundedTimeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0;
  if (!valid || !label || command.length === 0 || !boundedTimeout) {
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
    retryOnCrash,
    // The CLI has one on/off switch; the two options are only independent at
    // the function-level API tests exercise directly.
    preserveAttemptLogs: retryOnCrash,
  });
  process.exit(result.exitCode);
}
