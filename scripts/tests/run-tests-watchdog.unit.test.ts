import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runTestsWithWatchdog, type WatchdogOptions } from '../ci/run-tests-watchdog';

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

const optionsIn = (dir: string, overrides: Partial<WatchdogOptions>): WatchdogOptions => ({
  label: '3',
  command: ['bun', '-e', 'console.log("ok")'],
  timeoutSeconds: 30,
  killGraceSeconds: 1,
  logFile: join(dir, 'run.log'),
  metaFile: join(dir, 'shard-meta.json'),
  timingsDir: join(dir, 'timings'),
  cwd: dir,
  ...overrides,
});

describe('runTestsWithWatchdog', () => {
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
        command: ['bun', '-e', 'console.log("spinning"); setInterval(() => {}, 1000)'],
        timeoutSeconds: 1,
      })
    );

    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(124);
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({
      shard: 3,
      exitCode: 124,
    });
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
        timeoutSeconds: 30,
        stdout: sink,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 1 });
    const expected = `${lines.join('\n')}\n`;
    expect(sink.text()).toBe(expected);
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
        timeoutSeconds: 30,
      })
    );

    expect(result).toMatchObject({ exitCode: 1, attempts: 1 });
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({ exitCode: 1 });
  });

  // `timeoutSeconds` is generous here on purpose: the first attempt has to
  // reach its `writeFileSync` before the watchdog kills it, and a loaded CI
  // runner can spend most of a second just starting `bun`.
  it('retries a hung first attempt and reports the second attempt green', async () => {
    const dir = await makeTemp();
    // First run leaves a marker and hangs; the second sees the marker and exits 0.
    const marker = join(dir, 'first-attempt-ran');
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      setInterval(() => {}, 1000);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 3 })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
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
      setInterval(() => {}, 1000);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 3 })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
  });

  // `--update-timings` may rewrite a lane's baseline to this shard's slice
  // before the hang. A retry balancing against different bytes than the other
  // shards computes a different partition — files run twice or not at all —
  // so the retry must re-read the exact baseline the first attempt started
  // from.
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
      setInterval(() => {}, 1000);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', script],
        timeoutSeconds: 3,
        logFile,
        preserveAttemptLogs: true,
        stdout: sink,
      })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(sink.text()).toContain('Watchdog could not preserve');
    expect(await Bun.file(join(dir, 'shard-meta.json')).json()).toMatchObject({ exitCode: 0 });
  });

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
      setInterval(() => {}, 1000);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 3 })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(await Bun.file(timingsFile).text()).toBe(baseline);
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
        preserveAttemptLogs: true,
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
  // findings-free crash-then-retry into a phantom non-zero exit.
  it('does not mistake a clean run\'s "0 fail" summary line for a finding', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: [
          'bun',
          '-e',
          crashOnceThenScript(marker, 'console.log("0 fail"); process.exit(0);'),
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
      optionsIn(dir, { command: ['bash', '-c', script], retryOnCrash: true })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
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
      setInterval(() => {}, 1000);
    `;

    const result = await runTestsWithWatchdog(
      optionsIn(dir, {
        command: ['bun', '-e', script],
        timeoutSeconds: 3,
        retryOnCrash: true,
        preserveAttemptLogs: true,
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

    await runTestsWithWatchdog(optionsIn(dir, { retryOnCrash: true, preserveAttemptLogs: true }));

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

  // Regression: a crashed main thread's isolate worker could outlive the
  // attempt and keep running into the retry. The straggler here inherits the
  // crashed attempt's process group and would write its marker file 500ms
  // after being spawned unless the group is reaped before the retry starts.
  it("reaps a crashed attempt's process group before retrying", async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const strayMarker = join(dir, 'stray-wrote');
    const straySurvivalScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(strayMarker)}, ""), 500)`;
    const script = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      if (fs.existsSync(${JSON.stringify(marker)})) {
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      spawn("bun", ["-e", ${JSON.stringify(straySurvivalScript)}], { stdio: "ignore" }).unref();
      console.log("panic(main thread): abort()");
      process.exit(134);
    `;

    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], retryOnCrash: true })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    await Bun.sleep(800);
    expect(await Bun.file(strayMarker).exists()).toBe(false);
  });
});
