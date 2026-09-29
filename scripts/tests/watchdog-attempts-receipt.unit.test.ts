// The watchdog's receipt (`shard-meta.json`) must say how many attempts the job
// took. A hang that a clean second attempt recovered exits 0, so without the
// count the QA report cannot tell that the job ran twice.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTestsWithWatchdog, type WatchdogOptions } from '../ci/run-tests-watchdog';

const temps: string[] = [];
const makeTemp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-watchdog-attempts-'));
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

const receipt = async (dir: string): Promise<Record<string, unknown>> =>
  (await Bun.file(join(dir, 'shard-meta.json')).json()) as Record<string, unknown>;

describe('shard-meta attempts', () => {
  it('records one attempt for a run that needed no retry', async () => {
    const dir = await makeTemp();

    await runTestsWithWatchdog(optionsIn(dir, {}));

    const meta = await receipt(dir);
    expect(meta.attempts, `expected receipt attempts: 1 | received: ${meta.attempts}`).toBe(1);
  });

  it('records two attempts when a hang was killed and the retry came back clean', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    // Hangs on its first attempt, exits 0 on the second.
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      setInterval(() => {}, 1000);
    `;

    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 2 })
    );

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    const meta = await receipt(dir);
    expect(meta.exitCode).toBe(0);
    expect(
      meta.attempts,
      `expected receipt attempts: 2 | received: ${meta.attempts} (a retried job must not look like a first-try pass)`
    ).toBe(2);
  }, 30_000);
});
