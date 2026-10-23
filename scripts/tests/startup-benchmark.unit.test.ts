import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { ownsStartupState } from '../bench/startup';
import {
  type NativeProcess,
  runNativeCommand,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';

import { FakeBenchmarkCancelBarrier } from './support/benchmark-cancel-barrier';

const ROOT = resolve(import.meta.dir, '../..');
const scratch: string[] = [];
const escapedFixtures: NativeProcess[] = [];

afterEach(async () => {
  const current = await snapshotNativeProcesses();
  for (const fixture of escapedFixtures.splice(0)) {
    if (current.some((row) => row.pid === fixture.pid && row.identity === fixture.identity))
      process.kill(fixture.pid, 'SIGKILL');
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class DiscardedBenchmarkOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}

/** A local executable which succeeds once after warmup, then rejects its next startup. */
class FakeStartupBinary {
  constructor(
    private readonly directory: string,
    private readonly stall = false
  ) {}

  async create(): Promise<string> {
    const binary = join(this.directory, 'fake-startup-binary');
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.HOME;
const counterPath = join(home, 'startup-counter');
const count = Number(await Bun.file(counterPath).text().catch(() => '0')) + 1;
await Bun.write(counterPath, String(count));
if (count === 3 && ${this.stall}) { await Bun.write(${JSON.stringify(join(this.directory, 'stall-reached'))}, 'later startup attempt'); console.error('Intentional fixture startup cancellation'); setInterval(() => {}, 1000); while (!(await Bun.file(${JSON.stringify(join(this.directory, 'cancel-now'))}).exists())) await Bun.sleep(5); process.kill(process.ppid, 'SIGTERM'); await new Promise(() => {}); }
if (count === 3) {
  console.error('Intentional fixture startup failure after one measured success');
  process.exit(3);
}
const port = Number(process.argv.at(-1));
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ status: 'ok' }) });
const stateDir = join(home, '.mango', 'run');
await mkdir(stateDir, { recursive: true });
await Bun.write(join(stateDir, 'server.json'), JSON.stringify({ pid: process.pid, port, host: '127.0.0.1', startedAt: Date.now() }));
process.on('SIGTERM', () => { server.stop(true); process.exit(0); });
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}

describe.skipIf(process.platform === 'win32')('startup benchmark receipts', () => {
  it('preserves finished samples when the intended later attempt cancels the benchmark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-startup-cancel-test-'));
    scratch.push(directory);
    const binary = await new FakeStartupBinary(directory, true).create();
    const output = join(directory, 'receipt.json');
    const journal = `${output}.jsonl`;
    const pending = runNativeCommand({
      label: 'startup-cancel',
      command: [
        process.execPath,
        'scripts/bench/startup.ts',
        binary,
        '--warm',
        '--runs',
        '2',
        '--json',
        '--output',
        output,
      ],
      root: ROOT,
      out: directory,
      env: { ...process.env },
      timeoutSeconds: 20,
      pollIntervalMs: 20,
      stream: new DiscardedBenchmarkOutput(),
    });
    const barrier = new FakeBenchmarkCancelBarrier(directory);
    escapedFixtures.push(...(await barrier.observe(binary, pending)));
    await barrier.release();
    const result = await pending;
    escapedFixtures.push(...result.settlement.survivors);
    expect(await Bun.file(join(directory, 'stall-reached')).exists()).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(await Bun.file(journal).exists()).toBe(true);
    const events = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; phase?: string; status?: string });
    expect(
      events
        .filter((event) => event.kind === 'finished')
        .map(({ phase, status }) => ({ phase, status }))
    ).toEqual([
      { phase: 'warmup', status: 'success' },
      { phase: 'measured', status: 'success' },
      { phase: 'measured', status: 'failed' },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'finished', phase: 'measured', status: 'failed' });
    const progress = JSON.parse(await readFile(output, 'utf8')) as {
      complete: boolean;
      attempts: unknown[];
    };
    expect(progress.complete).toBe(false);
    expect(progress.attempts).toHaveLength(3);
  }, 30_000);

  it('retains warmup, successful and failed attempts when a later startup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-startup-receipt-test-'));
    scratch.push(directory);
    const binary = await new FakeStartupBinary(directory).create();
    const result = await runNativeCommand({
      label: 'startup-receipt',
      command: [
        process.execPath,
        'scripts/bench/startup.ts',
        binary,
        '--warm',
        '--runs',
        '2',
        '--json',
      ],
      root: ROOT,
      out: directory,
      env: { ...process.env },
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      stream: new DiscardedBenchmarkOutput(),
    });
    const stdout = await readFile(join(directory, 'logs/startup-receipt.stdout.log'), 'utf8');
    const stderr = await readFile(join(directory, 'logs/startup-receipt.stderr.log'), 'utf8');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(`${stdout}\n${stderr}`).toContain(
      'Intentional fixture startup failure after one measured success'
    );
    expect(stdout).toContain('"attempts"');
    const receipt = JSON.parse(stdout) as { attempts: Array<{ phase: string; status: string }> };
    expect(receipt.attempts.map(({ phase, status }) => ({ phase, status }))).toEqual([
      { phase: 'warmup', status: 'success' },
      { phase: 'measured', status: 'success' },
      { phase: 'measured', status: 'failed' },
    ]);
  });
});

describe('startup child identity', () => {
  it('requires the current pid, bound port and a fresh isolated state record', () => {
    const state = { pid: 42, port: 3001, startedAt: 100 };
    expect(ownsStartupState(state, 42, 3001, 99)).toBe(true);
    expect(ownsStartupState(state, 43, 3001, 99)).toBe(false);
    expect(ownsStartupState(state, 42, 3002, 99)).toBe(false);
    expect(ownsStartupState(state, 42, 3001, 101)).toBe(false);
    expect(ownsStartupState(null, 42, 3001, 99)).toBe(false);
    expect(ownsStartupState({ ...state, startedAt: '100' }, 42, 3001, 99)).toBe(false);
    expect(ownsStartupState({ ...state, startedAt: Number.POSITIVE_INFINITY }, 42, 3001, 99)).toBe(
      false
    );
  });
});
