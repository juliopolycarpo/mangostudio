import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  killProcessGroup,
  runTestsWithWatchdog,
  type WatchdogOptions,
} from '../ci/run-tests-watchdog';
import { BUN_ORPHAN_POLICY_ENV, fixtureChildEnvironment } from './support/child-supervision';
import { FakeProcessGroupPort } from './support/fake-process-group-port';
import { readWatchdogStrayPid } from './support/fake-watchdog-crash';
import { forceKill } from './support/process-tree';

/**
 * A sink that accepts every chunk but never synchronously. `highWaterMark: 1`
 * plus a deferred callback makes `write()` return false on essentially every
 * chunk, so the forwarder has to pause the child and wait for `drain` — the
 * path a real CI stdout pipe takes once its buffer fills.
 */
class SlowSink extends Writable {
  private readonly chunks: Buffer[] = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    setImmediate(done);
  }

  text(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

/** A sink that needs a few milliseconds per chunk, as a CI stdout pipe under load does. */
class DelayedSink extends Writable {
  private readonly chunks: Buffer[] = [];

  constructor(private readonly delayMs: number) {
    super({ highWaterMark: 1 });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    setTimeout(done, this.delayMs);
  }

  text(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

/** A plain capturing sink, for tests that only need to read back what was written. */
class CaptureSink extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

const temps: string[] = [];

const makeTemp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-watchdog-'));
  temps.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// `runTestsWithWatchdog` appends to `$GITHUB_OUTPUT` when `retryOnCrash` is
// on, and this suite runs inside real CI steps where that variable is
// genuinely set — without this, every crash-mode test here would append to
// the *test step's own* output file instead of a throwaway one.
let originalGithubOutput: string | undefined;

beforeEach(() => {
  originalGithubOutput = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
});

afterEach(() => {
  if (originalGithubOutput === undefined) delete process.env.GITHUB_OUTPUT;
  else process.env.GITHUB_OUTPUT = originalGithubOutput;
});

// A fixture that must hang prints this once its setup is done. The watchdog
// clock starts on seeing it, so a short bound is safe on a slow runner: the
// child is never killed mid-setup, and no case waits out a CI-sized timeout.
const HANG_READY_LINE = 'watchdog-fixture-ready';
const HANG_UNTIL_KILLED = `console.log(${JSON.stringify(HANG_READY_LINE)}); setInterval(() => {}, 1000);`;

const waitForHangReadyLine = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(HANG_READY_LINE)) resolve();
    });
  });

const HUNG_ATTEMPT_TIMING = {
  timeoutSeconds: 0.2,
  timeoutStartsWhen: waitForHangReadyLine,
} satisfies Partial<WatchdogOptions>;

const optionsIn = (dir: string, overrides: Partial<WatchdogOptions>): WatchdogOptions => ({
  label: '3',
  command: ['bun', '-e', 'console.log("ok")'],
  // Keep synthetic findings out of the outer run's log: another lane may
  // hang after these fixtures pass, and its watchdog must see only real findings.
  stdout: new CaptureSink(),
  timeoutSeconds: 30,
  killGraceSeconds: 1,
  // The CI default is 2s, and every crash-path test below reaches the reap.
  // Overridden here for the same reason `killGraceSeconds` is: the wait
  // guards against a straggler worker, and nothing in these fixtures needs
  // seconds of it.
  crashReapGraceSeconds: 0.2,
  logFile: join(dir, 'run.log'),
  metaFile: join(dir, 'shard-meta.json'),
  timingsDir: join(dir, 'timings'),
  cwd: dir,
  ...overrides,
});

describe('runTestsWithWatchdog', () => {
  it('passes an explicit environment only to the attempt child', async () => {
    const dir = await makeTemp();
    const parentPolicy = process.env[BUN_ORPHAN_POLICY_ENV];

    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', 'console.log(process.env.MANGOSTUDIO_FAKE_WATCHDOG_ENV)'],
        env: { ...fixtureChildEnvironment(), MANGOSTUDIO_FAKE_WATCHDOG_ENV: 'attempt-child' },
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    expect(await Bun.file(join(dir, 'run.log')).text()).toContain('attempt-child');
    expect(process.env.MANGOSTUDIO_FAKE_WATCHDOG_ENV).toBeUndefined();
    expect(process.env[BUN_ORPHAN_POLICY_ENV]).toBe(parentPolicy);
  });

  it('passes a green run through with its output logged and meta recorded', async () => {
    const dir = await makeTemp();
    const result = await runTestsWithWatchdog(optionsIn(dir, {}));

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    expect(await Bun.file(join(dir, 'run.log')).text()).toContain('ok');
    // A numeric label lands in the meta as a number, matching what the shard
    // jobs wrote before the watchdog existed.
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({
      shard: 3,
      exitCode: 0,
    });
  });

  // A real failure must surface as-is: retrying it would give flaky tests a
  // second roll of the dice and double the wall clock of every red run.
  it('does not retry an ordinary failure', async () => {
    const dir = await makeTemp();
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', 'process.exit(3)'] })
    );

    expect(result).toMatchObject({ exitCode: 3, attempts: 1 });
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({ exitCode: 3 });
  });

  // The hang this tool exists for: a process that never exits (oven-sh/bun#39709).
  it('kills a hung command and retries once', async () => {
    const dir = await makeTemp();
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', HANG_UNTIL_KILLED],
        ...HUNG_ATTEMPT_TIMING,
      })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(124);
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({
      shard: 3,
      exitCode: 124,
    });
  });

  // The gate is what lets hung fixtures use a sub-second bound: the clock must
  // not start before the child says it is ready, or a slow start is killed mid-setup.
  it('starts the timeout clock only after timeoutStartsWhen resolves', async () => {
    const dir = await makeTemp();
    const gateOpened = Promise.withResolvers<void>();
    const startedAt = Date.now();
    let openedAt = 0;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', HANG_UNTIL_KILLED],
        timeoutSeconds: 0.2,
        timeoutStartsWhen: async () => {
          await Bun.sleep(600);
          openedAt = Date.now();
          gateOpened.resolve();
        },
      })
    );
    await gateOpened.promise;

    expect(result.exitCode, '(hung exit code): expected 124 after both attempts hang').toBe(124);
    // Two attempts each wait 600 ms for the gate and 200 ms for the clock; an
    // ungated clock would kill both at 200 ms and finish well under 1 s.
    expect(
      Date.now() - startedAt,
      `(elapsed ms, gate opened at ${openedAt - startedAt}): expected >= 1600`
    ).toBeGreaterThanOrEqual(1600);
  });

  // Both sinks refuse chunks once their buffers fill, and a forwarder that
  // ignores that keeps the whole run's output on the heap instead of pausing
  // the child. Pausing is only half the fix: a resume that never fires would
  // deadlock here — the child would never exit, the watchdog would kill it at
  // the bound and report a hang that was really the forwarder's fault.
  it('applies backpressure without losing or reordering output', async () => {
    const dir = await makeTemp();
    const sink = new SlowSink();
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index}`);
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', 'for (let i = 0; i < 200; i++) console.log("line-" + i);'],
        ...HUNG_ATTEMPT_TIMING,
        stdout: sink,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    const expected = `${lines.join('\n')}\n`;
    expect(sink.text()).toBe(expected);
    expect(await Bun.file(join(dir, 'run.log')).text()).toBe(expected);
  });

  // `exit` can fire while the child's last output is still in the pipe, or queued behind a sink that
  // takes a moment per chunk. A runner that returns on `exit` hands the caller (and the job log, and
  // the failure artifact) a truncated tail. The sink here is slower than the child, so the child is
  // long gone before the last chunk is written.
  it('delivers the whole output of a child that exits before its sink has taken it', async () => {
    const dir = await makeTemp();
    const sink = new DelayedSink(2);
    const lines = Array.from({ length: 300 }, (_, index) => `line-${index}`);
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', 'for (let i = 0; i < 300; i++) console.log("line-" + i);'],
        ...HUNG_ATTEMPT_TIMING,
        stdout: sink,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    const expected = `${lines.join('\n')}\n`;
    const forwarded = sink.text();
    expect(
      forwarded.length,
      `expected all ${expected.length} bytes forwarded when the runner returned | received ${forwarded.length}`
    ).toBe(expected.length);
    expect(forwarded).toBe(expected);
    expect(await Bun.file(join(dir, 'run.log')).text()).toBe(expected);
  });

  // A command that cannot start emits `error` and may never emit `exit`.
  // Without a listener Node throws it, killing the watchdog before it writes
  // the meta file the merge job reads; with one but no `exit`, the two
  // attempts would burn their full timeouts waiting for a process that does
  // not exist. Both must degrade to an ordinary, un-retried failure.
  it('fails fast when the command cannot be spawned', async () => {
    const dir = await makeTemp();
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: [join(dir, 'no-such-executable'), 'arg'],
        ...HUNG_ATTEMPT_TIMING,
      })
    );

    expect(result).toMatchObject({ exitCode: 1, attempts: 1 });
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({ exitCode: 1 });
  });

  // The hung fixtures print HANG_READY_LINE after their setup; the timeout clock starts then.
  it('retries a hung first attempt and keeps a green retry green despite mirrored failures', async () => {
    const dir = await makeTemp();
    // First run leaves a marker and hangs; the second sees the marker and exits 0.
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("@mangostudio/api:test: (fail) quoted by a fixture [1.00ms]");
        console.log("@mangostudio/api:test:  2 fail");
        console.log("@mangostudio/api:test: # Unhandled error between tests");
        console.log("@mangostudio/api:test:  1 error");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      ${HANG_UNTIL_KILLED}
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], ...HUNG_ATTEMPT_TIMING })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
  });

  // The merge-gate coverage caller retries hangs without opting into crash
  // retries. A clean second attempt must still surface its first findings.
  it.each([
    ['inline failure', '@mangostudio/api:test: (fail) stale database [1.20ms]'],
    ['failure summary', '@mangostudio/api:test:  2 fail'],
    ['unhandled-error heading', '@mangostudio/api:test: # Unhandled error between tests'],
    ['unhandled-error count', '@mangostudio/api:test:  1 error'],
  ])('retains findings from a hung attempt without crash retry: %s', async (_signal, line) => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;
    const sink = new CaptureSink();
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("@mangostudio/api:test:  0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log(${JSON.stringify(line)});
      ${HANG_UNTIL_KILLED}
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], ...HUNG_ATTEMPT_TIMING, stdout: sink })
    );

    expect(result).toMatchObject({ exitCode: 1, attempts: 2 });
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({
      exitCode: 1,
      attempts: 2,
    });
    expect(sink.text()).toContain(line);
    expect(sink.text()).toContain('retaining exit code 1 after a clean retry');
    // No `crashed=` key without crash retry; the preserved first attempt is
    // reported because any retry now keeps it.
    expect(await Bun.file(githubOutput).text()).toBe('log-preserved=true\n');
  });

  // The cold-cache half of the same invariant: with no baseline to restore,
  // "absent" is the state the retry has to see. Leaving the killed attempt's
  // `--update-timings` output behind makes the retry balance against this
  // shard's own partial slice while the other shards round-robin, which is a
  // different partition — the failure the restore exists to prevent.
  it('clears a timings directory the first attempt created when there was no baseline', async () => {
    const dir = await makeTemp();
    const timingsFile = join(dir, 'timings', 'api-unit.json');
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        process.exit(fs.existsSync(${JSON.stringify(timingsFile)}) ? 9 : 0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      fs.mkdirSync(${JSON.stringify(join(dir, 'timings'))}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(timingsFile)}, "written-by-attempt-1");
      ${HANG_UNTIL_KILLED}
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], ...HUNG_ATTEMPT_TIMING })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
  });

  // `--update-timings` may rewrite a lane's baseline to this shard's slice
  // before the hang. A retry balancing against different bytes than the other
  // shards computes a different partition — files run twice or not at all —
  // so the retry must re-read the exact baseline the first attempt started
  // from.
  it('restores the timings baseline before the retry', async () => {
    const dir = await makeTemp();
    const timingsDir = join(dir, 'timings');
    await mkdir(timingsDir, { recursive: true });
    const baseline = '{"version":1,"files":{"tests/unit/a.test.ts":10}}';
    await writeFile(join(timingsDir, 'api-unit.json'), baseline);

    const timingsFile = join(timingsDir, 'api-unit.json');
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        // The retry must see the baseline, not the first attempt's clobber.
        const content = fs.readFileSync(${JSON.stringify(timingsFile)}, "utf8");
        process.exit(content.includes("a.test.ts") ? 0 : 9);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      fs.writeFileSync(${JSON.stringify(timingsFile)}, "clobbered");
      ${HANG_UNTIL_KILLED}
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], ...HUNG_ATTEMPT_TIMING })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(await Bun.file(timingsFile).text()).toBe(baseline);
  });

  // A `createWriteStream` that never opened (full disk, missing directory)
  // leaves nothing at `logFile` for `preserveAttemptLog`'s `rename()` to find.
  // That must warn and fall through to the retry, not reject and skip the
  // retry, the meta-file write, and the GitHub output entirely.
  it('does not let a preserved-log rename failure cancel the retry', async () => {
    const dir = await makeTemp();
    const logFile = join(dir, 'run.log');
    const marker = join(dir, 'first-attempt-ran');
    const sink = new CaptureSink();
    // Unlinks its own log file before hanging, so the retry's rename() has
    // nothing to find — the same shape a failed createWriteStream leaves.
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      fs.unlinkSync(${JSON.stringify(logFile)});
      ${HANG_UNTIL_KILLED}
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', script],
        ...HUNG_ATTEMPT_TIMING,
        logFile,
        stdout: sink,
      })
    );

    // The retry ran and wrote its receipt. Exit 1, not 0: the unlinked log is also
    // unreadable to the failure scan, and a first attempt nobody can read is
    // assumed to have failed (the clean retry cannot clear it).
    expect(result).toMatchObject({ exitCode: 1, attempts: 2 });
    expect(sink.text()).toContain('Watchdog could not preserve');
    expect(sink.text()).toContain(`could not read ${logFile}`);
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({
      exitCode: 1,
      attempts: 2,
      failuresSeen: true,
    });
  });
});

// A crash marker file lets a script behave differently on its first and
// second invocation without any external state beyond the child's own
// filesystem — the same shape the hang-retry tests above use.
const crashOnceThenScript = (marker: string, onRetry: string): string => `
  const fs = require("node:fs");
  if (fs.existsSync(${JSON.stringify(marker)})) {
    ${onRetry}
  }
  fs.writeFileSync(${JSON.stringify(marker)}, "");
  console.log("panic(main thread): abort()");
  console.log("oh no: Bun has crashed");
  process.exit(134);
`;

describe('runTestsWithWatchdog crash retry (retryOnCrash)', () => {
  it('retries a crash once and reports the clean retry green, with attempt 1 preserved', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const sink = new CaptureSink();
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', crashOnceThenScript(marker, 'process.exit(0);')],
        retryOnCrash: true,
        stdout: sink,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(sink.text()).toContain('::warning::');
    expect(sink.text()).toContain('crashed');
    expect(await Bun.file(`${join(dir, 'run.log')}.attempt-1`).text()).toContain(
      'panic(main thread): abort()'
    );
  });

  // Regression: Bun's own summary always prints a " 0 fail" line on a clean
  // run, and a failure scan on bare `\d+` would match that zero — turning a
  // findings-free crash-then-retry into a phantom non-zero exit. Same trap
  // for a `0 error` line if one ever appears.
  it('does not mistake a clean run\'s "0 fail" summary line for a finding', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: [
          'bun',
          '-e',
          crashOnceThenScript(
            marker,
            'console.log("0 fail"); console.log("0 error"); process.exit(0);'
          ),
        ],
        retryOnCrash: true,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
  });

  // Findings outrank the clean retry: the crash only proves the isolate
  // runner recovered, not that the failures attempt 1 reported didn't happen.
  it('reports a non-zero exit when an earlier attempt logged failures before crashing', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("2 fail");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  // The shape the summary scan alone cannot see: the isolate runner aborts
  // partway through the file list, so Bun never reaches its ` N fail` line —
  // but it already printed the `(fail)` lines for the tests that did run. A
  // clean retry must not report green over them.
  it('reports a non-zero exit when a crash cut the run off before the summary', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("(fail) leaky > reads a stale database [1.20ms]");
      console.log("panic(main thread): abort()");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  // The shape neither `(fail)` nor `N fail` can see: Bun reported only
  // `# Unhandled error between tests` / `N error(s)` (JUnit stays green;
  // scripts/qa-gate/unhandled-errors.ts exists for this) and then crashed.
  // A clean retry must not hide that signal.
  it('reports a non-zero exit when a crash cut off an unhandled-error heading', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("# Unhandled error between tests");
      console.log("panic(main thread): abort()");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  it('reports a non-zero exit when a crash follows a Bun unhandled-error count', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("0 fail");
      console.log("@mangostudio/api:test:  1 error");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  // `bun run test` reaches the log through turbo `--ui=stream`, which prefixes
  // every line with `<package>:<task>: `. A `^`-anchored scan of the raw text
  // matches nothing under that caller — silently, and in the direction that
  // reads as green.
  it.each([
    ['inline failures', '@mangostudio/api:test: (fail) stale database [1.20ms]'],
    ['failure summaries', '@mangostudio/api:test:  2 fail'],
  ])('finds %s behind a turbo stream prefix', async (_signal, line) => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("@mangostudio/api:test:  0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log(${JSON.stringify(line)});
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  // Widening the scan to inline `(fail)` lines widens what a *green* run can
  // match too: a suite that prints those strings as data — this very file
  // does, through the fixtures above — would otherwise turn its own exit 0
  // into a phantom 1. Bun cannot exit 0 with a failing test, so only a retry
  // can legitimately hide findings.
  it.each([undefined, true])(
    'does not turn a single green attempt into a failure over mirrored output with retryOnCrash=%s',
    async (retryOnCrash) => {
      const dir = await makeTemp();
      const script = `
      console.log("(fail) some suite > quoted by a fixture [1.00ms]");
      console.log("2 fail");
      process.exit(0);
    `;
      const result = await runTestsWithWatchdog(
        optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash })
      );

      expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    }
  );

  // Regression: the same mirrored-output trap, one attempt later. A crash with
  // no findings hands the verdict to the retry — and a *green* retry whose log
  // merely quotes `(fail)` is data, by the same "Bun cannot exit 0 with a
  // failing test" argument. Scanning it anyway turned a clean night red.
  it('does not turn a clean retry into a failure over its own mirrored output', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: [
          'bun',
          '-e',
          crashOnceThenScript(
            marker,
            'console.log("@mangostudio/api:test: (fail) quoted by a fixture [1.00ms]"); console.log("@mangostudio/api:test:  2 fail"); process.exit(0);'
          ),
        ],
        retryOnCrash: true,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
  });

  // Regression: the summary scans are anchored end-to-end, so an ordinary log
  // line that merely opens with a count — `1 error: …` is Bun's own module
  // resolution shape — cannot be mistaken for the ` N error` summary and flip
  // a findings-free crash retry to red.
  it('does not mistake a count-prefixed log line for a failure summary', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("1 error: Cannot find module 'left-pad'");
      console.log("3 failures were retried by the vendor CLI");
      console.log("panic(main thread): abort()");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
  });

  it('reports a non-zero exit when the retry crashes again', async () => {
    const dir = await makeTemp();
    const script = `
      console.log("panic(main thread): abort()");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result).toMatchObject({ exitCode: 134, attempts: 2 });
  });

  // A suite that *prints* the crash markers is not a crashed suite. This
  // file's own fixtures do exactly that, and `bun test scripts/` mirrors them
  // into the parent's stdout — so without the exit-code gate, every shard
  // carrying the scripts lane would retry itself and report `crashed=true` on
  // a run that passed.
  it('does not treat a green run that quotes the crash markers as a crash', async () => {
    const dir = await makeTemp();
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;
    const script = `
      console.log("oh no: Bun has crashed");
      console.log("panic(main thread): abort()");
      process.exit(0);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    expect(await Bun.file(githubOutput).text()).toContain('crashed=false\n');
  });

  // The no-retry-on-real-failure contract must survive crash mode: a plain
  // red run is not a crash and must not get a second roll of the dice.
  it('does not retry a plain failure even with retryOnCrash on', async () => {
    const dir = await makeTemp();
    const script = `
      console.log("1 fail");
      process.exit(1);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result).toMatchObject({ exitCode: 1, attempts: 1 });
  });

  // Merge-gate callers pass no new flags; a crash must surface exactly as it
  // did before this feature existed.
  it('does not retry a crash when retryOnCrash is unset', async () => {
    const dir = await makeTemp();
    const script = `
      console.log("panic(main thread): abort()");
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(optionsIn(dir, { command: ['bun', '-e', script] }));

    expect(result).toMatchObject({ exitCode: 134, attempts: 1 });
  });

  // The signal path is independent of the log-marker scan: a process that
  // dies by SIGABRT with no crash text in its output must still be caught.
  // `bash`, not `bun -e`, self-signals here — Bun's own runtime installs a
  // SIGABRT handler that prints its "oh no: Bun has crashed" banner, which
  // would leave the marker in the log anyway and defeat the point of this
  // case.
  it('classifies a bare SIGABRT exit as a crash with no log marker present', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      if [ -f ${JSON.stringify(marker)} ]; then exit 0; fi
      touch ${JSON.stringify(marker)}
      kill -ABRT $$
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        // MSYS Bash reports a self-SIGABRT as exit0 to native Windows callers.
        // Use its conventional status explicitly there; preserve the actual
        // POSIX signal fixture on hosts that expose that process status.
        command:
          process.platform === 'win32'
            ? [
                'bun',
                '-e',
                `const fs = require('node:fs'); const marker = ${JSON.stringify(marker)}; if (fs.existsSync(marker)) process.exit(0); fs.writeFileSync(marker, ''); process.exit(134);`,
              ]
            : ['bash', '-c', script],
        retryOnCrash: true,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    // Load-bearing, not decoration: if the shell ever printed something the
    // markers matched, this test would still pass — via the marker path,
    // leaving the signal-derived `exitCode === CRASH_EXIT_CODE` branch it
    // exists for uncovered.
    const attemptOne = await Bun.file(`${join(dir, 'run.log')}.attempt-1`).text();
    expect(attemptOne).not.toContain('Bun has crashed');
    expect(attemptOne).not.toContain('panic(main thread)');
  });

  it('writes crashed=true to $GITHUB_OUTPUT when a crash was retried', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;

    await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', crashOnceThenScript(marker, 'process.exit(0);')],
        retryOnCrash: true,
      })
    );

    expect(await Bun.file(githubOutput).text()).toContain('crashed=true\n');
  });

  it('writes crashed=false to $GITHUB_OUTPUT for a clean run in crash mode', async () => {
    const dir = await makeTemp();
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;

    await runTestsWithWatchdog(optionsIn(dir, { retryOnCrash: true }));

    expect(await Bun.file(githubOutput).text()).toContain('crashed=false\n');
  });

  // A hang that retries clean never sets `crashed`, but `retry()` still
  // preserves attempt 1's log — the nightly workflow's artifact-upload step
  // needs its own signal for that case, or the only evidence of the hang is
  // silently dropped from a green step.
  it('writes log-preserved=true to $GITHUB_OUTPUT after a hung attempt retries clean', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      ${HANG_UNTIL_KILLED}
    `;

    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', script],
        ...HUNG_ATTEMPT_TIMING,
        retryOnCrash: true,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    const output = await Bun.file(githubOutput).text();
    expect(output).toContain('crashed=false\n');
    expect(output).toContain('log-preserved=true\n');
    expect(await Bun.file(`${join(dir, 'run.log')}.attempt-1`).exists()).toBe(true);
  });

  it('writes log-preserved=false to $GITHUB_OUTPUT for a clean run with no retry', async () => {
    const dir = await makeTemp();
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;

    await runTestsWithWatchdog(optionsIn(dir, { retryOnCrash: true }));

    expect(await Bun.file(githubOutput).text()).toContain('log-preserved=false\n');
  });

  // Regression: a failure summary followed by more than 200 lines of panic
  // dump used to fall outside the tail slice the scan used to inspect,
  // silently dropping a real finding once the retry came back clean.
  it('finds a failure summary trailed by a panic dump past the old 200-line tail window', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const paddingLines = Array.from(
      { length: 250 },
      (_, index) => `console.log("panic dump line ${index}");`
    ).join('\n');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        console.log("0 fail");
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("2 fail");
      ${paddingLines}
      process.exit(134);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  // A crashed main thread's isolate worker can outlive the attempt. The
  // retry checks the first attempt's stray before it performs any other work.
  it("reaps a crashed attempt's process group before retrying", async () => {
    const dir = await makeTemp();
    const sink = new CaptureSink();
    try {
      // Inherited --no-orphans would stop the stray before the watchdog acts.
      const result = await runTestsWithWatchdog(
        optionsIn(dir, {
          command: [process.execPath, join(import.meta.dir, 'support/fake-watchdog-crash.ts')],
          retryOnCrash: true,
          env: fixtureChildEnvironment(),
          stdout: sink,
        })
      );
      const stray = readWatchdogStrayPid(dir);
      expect(stray, 'expected the first attempt to publish its stray PID').toBeDefined();
      expect(result, sink.text()).toMatchObject({ exitCode: 0, attempts: 2 });
      expect(sink.text()).toContain(`stray alive before crash: ${stray}`);
      expect(sink.text()).toContain(`retry observed stopped stray: ${stray}`);
    } finally {
      const stray = readWatchdogStrayPid(dir);
      if (stray !== undefined) forceKill(stray);
    }
  });
});

describe('crash reap against a fake process-group port', () => {
  // The child exits 134 on its first run and 0 on the retry; the port, not the
  // kernel, decides what the group looks like once the leader is reaped.
  const runCrashOnce = async (
    port: FakeProcessGroupPort,
    graceSeconds: number
  ): Promise<{
    result: Awaited<ReturnType<typeof runTestsWithWatchdog>>;
    text: string;
    ms: number;
  }> => {
    const dir = await makeTemp();
    const sink = new CaptureSink();
    const startedAt = performance.now();
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: [
          'bun',
          '-e',
          crashOnceThenScript(join(dir, 'first-attempt-ran'), 'process.exit(0);'),
        ],
        retryOnCrash: true,
        processGroups: port,
        crashReapGraceSeconds: graceSeconds,
        stdout: sink,
      })
    );
    return { result, text: sink.text(), ms: performance.now() - startedAt };
  };

  it('does not signal a group that was already empty when the leader exited', async () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: false });

    const { result, text, ms } = await runCrashOnce(port, 20);

    expect(result, text).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(
      port.kills(),
      `(crash reap): expected no kill of a group that was empty at exit | received: ${JSON.stringify(port.kills())}`
    ).toEqual([]);
    expect(ms, '(crash reap): expected no grace wait when nothing was signalled').toBeLessThan(
      15_000
    );
  });

  it('kills the group it saw alive at exit and pays the grace once the kill lands', async () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: true });

    const { result, text, ms } = await runCrashOnce(port, 1);

    expect(result, text).toMatchObject({ exitCode: 0, attempts: 2 });
    const [probe] = port.signals;
    expect(probe?.signal, '(crash reap): expected the exit-time probe first').toBe(0);
    expect(port.kills()).toEqual([{ pid: probe?.pid as number, signal: 'SIGKILL' }]);
    expect(ms, '(crash reap): expected the 1s grace after a landed kill').toBeGreaterThanOrEqual(
      950
    );
  });

  it('surfaces a refused kill and skips the grace it would have waited for', async () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: true, killFailsWith: 'EPERM' });

    const { result, text, ms } = await runCrashOnce(port, 20);

    // The retry still runs: a failed reap must not cancel it.
    expect(result, text).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(text).toMatch(/Watchdog could not signal SIGKILL to process group \d+: EPERM/);
    expect(ms, '(crash reap): expected no grace wait after a refused kill').toBeLessThan(15_000);
  });

  it('treats a group that vanished between the probe and the kill as nothing to kill', async () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: true, killFailsWith: 'ESRCH' });

    const { result, text, ms } = await runCrashOnce(port, 20);

    expect(result, text).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(text).not.toContain('Watchdog could not signal');
    expect(ms, '(crash reap): expected no grace wait when the group was gone').toBeLessThan(15_000);
  });
});

describe('killProcessGroup', () => {
  it('reports delivered when the signal lands', () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: true });

    expect(killProcessGroup(port, 4242, 'SIGKILL')).toEqual({ kind: 'delivered' });
  });

  it('reports absent for ESRCH, the "nothing to kill" answer', () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: true, killFailsWith: 'ESRCH' });

    expect(killProcessGroup(port, 4242, 'SIGKILL')).toEqual({ kind: 'absent' });
  });

  it('reports failed with the errno and target for any other error', () => {
    const port = new FakeProcessGroupPort({ aliveWhenProbed: true, killFailsWith: 'EPERM' });

    const outcome = killProcessGroup(port, 4242, 'SIGKILL');

    expect(outcome).toEqual({
      kind: 'failed',
      message: 'signal SIGKILL to process group 4242: EPERM kill EPERM',
    });
  });
});

// Regression for the merge-gate shards: they retry on a hang without ever
// passing retryOnCrash, and the retry's `createWriteStream('w')` used to erase
// attempt 1's log, taking its findings with it.
describe('attempt log preservation without retryOnCrash', () => {
  const hangOnceThenScript = (marker: string, logLine: string): string => `
    const fs = require("node:fs");
    if (fs.existsSync(${JSON.stringify(marker)})) {
      console.log("attempt two output");
      process.exit(0);
    }
    fs.writeFileSync(${JSON.stringify(marker)}, "");
    console.log(${JSON.stringify(logLine)});
    ${HANG_UNTIL_KILLED}
  `;

  it('keeps the hung first attempt at <logFile>.attempt-1 and the retry at <logFile>', async () => {
    const dir = await makeTemp();
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;

    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: [
          'bun',
          '-e',
          hangOnceThenScript(join(dir, 'first-attempt-ran'), '(fail) a > b [0.37ms]'),
        ],
        ...HUNG_ATTEMPT_TIMING,
      })
    );

    expect(result).toMatchObject({ attempts: 2 });
    const attemptOne = await Bun.file(join(dir, 'run.log.attempt-1')).text();
    expect(attemptOne, '(attempt-1 log): expected the hung attempt output').toContain(
      '(fail) a > b'
    );
    const final = await Bun.file(join(dir, 'run.log')).text();
    expect(final, '(run log): expected the retry output only').toContain('attempt two output');
    expect(final).not.toContain('(fail) a > b');
    expect(await Bun.file(githubOutput).text()).toBe('log-preserved=true\n');
  });

  it('leaves no .attempt-1 log when the first attempt is the only one', async () => {
    const dir = await makeTemp();
    const githubOutput = join(dir, 'github-output');
    await writeFile(githubOutput, '');
    process.env.GITHUB_OUTPUT = githubOutput;

    const result = await runTestsWithWatchdog(optionsIn(dir, {}));

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    expect(await Bun.file(join(dir, 'run.log.attempt-1')).exists()).toBe(false);
    expect(await Bun.file(githubOutput).text()).toBe('log-preserved=false\n');
  });
});
