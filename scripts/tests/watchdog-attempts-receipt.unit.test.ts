// The watchdog's receipt (`shard-meta.json`) must say how many attempts the job
// took. A hang that a clean second attempt recovered exits 0, so without the
// count the QA report cannot tell that the job ran twice.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runTestsWithWatchdog, type WatchdogOptions } from '../ci/run-tests-watchdog';
import { normalizeLogLine } from '../lib/log-lines';
import { parseShardReceipt } from '../lib/shard-receipt';
import { BUN_AGENT_MARKER_ENV, nestedBunTestEnvironment } from './support/child-supervision';

/** Capture nested fixture findings without forwarding them to the enclosing test log. */
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
  // The outer CI watchdog can inspect an interrupted Bun test log. Synthetic
  // findings belong only to this fixture's capture and receipt.
  stdout: new CaptureSink(),
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
  it.each(['0', '1'])(
    'keeps synthetic findings out of the enclosing Bun test log with FORCE_COLOR=%s',
    (forceColor) => {
      // Every agent marker is set in the ambient environment on purpose: under
      // one, Bun omits the `(pass)` line asserted below, which failed this test
      // in agent sessions only.
      const agentSession = Object.fromEntries(BUN_AGENT_MARKER_ENV.map((marker) => [marker, '1']));
      const env = nestedBunTestEnvironment({ ...process.env, ...agentSession });
      env.FORCE_COLOR = forceColor;
      delete env.NO_COLOR;
      const child = Bun.spawnSync(
        [
          process.execPath,
          'test',
          import.meta.path,
          '--test-name-pattern',
          'records retained findings when a failed hanging attempt is followed by a pass',
        ],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 15_000,
        }
      );
      const output = `${child.stdout.toString()}\n${child.stderr.toString()}`
        .split('\n')
        .map((line) => normalizeLogLine(line).body)
        .join('\n');
      expect(child.exitCode, `expected nested fixture exit: 0 | received: ${output}`).toBe(0);
      expect(output, 'expected nested retained-findings fixture: executed and passed').toContain(
        'shard-meta attempts > records retained findings when a failed hanging attempt is followed by a pass'
      );
      expect(output, 'expected enclosing log: no synthetic failed-test finding').not.toContain(
        '(fail) earlier finding'
      );
    },
    20_000
  );

  it('records one attempt for a run that needed no retry', async () => {
    const dir = await makeTemp();

    await runTestsWithWatchdog(optionsIn(dir, {}));

    const meta = await receipt(dir);
    expect(meta).toMatchObject({ schemaVersion: 1, shard: 3, failuresSeen: false });
    expect(parseShardReceipt(JSON.stringify(meta), { expectedShard: 3 }).kind).toBe('valid');
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

  it('rejects a label the receipt cannot carry before running the suite', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'suite-ran');
    const run = runTestsWithWatchdog(
      optionsIn(dir, {
        label: 'Shard_1',
        command: ['bun', '-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`],
      })
    );
    await expect(run).rejects.toThrow(
      'Invalid watchdog label "Shard_1"; expected a positive shard number or a lowercase lane name'
    );
    expect(
      await Bun.file(marker).exists(),
      'expected suite state: not run | received: ran before the label was rejected'
    ).toBe(false);
  });

  it('records retained findings when a failed hanging attempt is followed by a pass', async () => {
    const dir = await makeTemp();
    const marker = join(dir, 'first-attempt-ran');
    const stdout = new CaptureSink();
    const script = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      console.log("(fail) earlier finding");
      setInterval(() => {}, 1000);
    `;
    const result = await runTestsWithWatchdog(
      optionsIn(dir, { command: ['bun', '-e', script], timeoutSeconds: 1, stdout })
    );
    expect(result.exitCode).toBe(1);
    expect(stdout.text()).toContain('(fail) earlier finding');
    const meta = await receipt(dir);
    expect(meta).toMatchObject({ schemaVersion: 1, attempts: 2, exitCode: 1, failuresSeen: true });
    expect(parseShardReceipt(JSON.stringify(meta))).toMatchObject({
      kind: 'valid',
      receipt: { exitCode: 1 },
    });
  }, 30_000);
});
