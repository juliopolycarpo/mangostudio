import { afterEach, describe, expect, it } from 'bun:test';
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

const temps: string[] = [];

const makeTemp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-watchdog-'));
  temps.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
