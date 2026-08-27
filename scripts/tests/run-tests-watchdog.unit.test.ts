import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTestsWithWatchdog, type WatchdogOptions } from '../ci/run-tests-watchdog';

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
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 1 })
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
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 1 })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(await Bun.file(timingsFile).text()).toBe(baseline);
  });
});
