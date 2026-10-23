import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
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
class DiscardedHandshakeOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}
class FakeRuntimeRefusingHandshake {
  constructor(
    private readonly root: string,
    private readonly successfulBeforeFailure = 0,
    private readonly stall = false
  ) {}
  async create(): Promise<string> {
    const binary = join(this.root, 'fake-runtime');
    await symlink(join(ROOT, 'node_modules'), join(this.root, 'node_modules'), 'dir');
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { Session } from '@mangostudio/protocol';
import { stdioPort } from '@mangostudio/protocol/stdio';
import { RUNTIME_CONTRACT_NAME, RUNTIME_CONTRACT_VERSION } from '@mangostudio/shared/runtime-contract';
if (process.argv.includes('--version')) { console.log('mangostudio-runtime 0.1.1'); process.exit(0); }
if (process.env.HOME !== process.env.MANGO_HOME || process.env.USERPROFILE !== process.env.MANGO_HOME) throw new Error('Fixture expected isolated matching HOME, USERPROFILE and MANGO_HOME');
const counterPath = ${JSON.stringify(join(this.root, 'counter'))};
const count = Number(await Bun.file(counterPath).text().catch(() => '0')) + 1;
await Bun.write(counterPath, String(count));
if (count > ${this.successfulBeforeFailure} && ${this.stall}) { await Bun.write(${JSON.stringify(join(this.root, 'stall-reached'))}, 'later handshake attempt'); console.error('Intentional fixture handshake cancellation'); setInterval(() => {}, 1000); while (!(await Bun.file(${JSON.stringify(join(this.root, 'cancel-now'))}).exists())) await Bun.sleep(5); process.kill(process.ppid, 'SIGTERM'); await new Promise(() => {}); }
if (count > ${this.successfulBeforeFailure}) {
  console.error('Intentional fixture handshake refusal');
  process.exit(3);
}
new Session(stdioPort(), { peer: { name: 'fixture-runtime', version: '0.1.1', role: 'tool' }, capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } }, handlers: { 'runtime.health': () => ({ status: 'ok' }) }, livenessIntervalMs: false });
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}
describe.skipIf(process.platform === 'win32')('protocol startup receipts', () => {
  it('preserves completed handshakes when the intended later attempt cancels the benchmark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-handshake-cancel-test-'));
    scratch.push(root);
    const binary = await new FakeRuntimeRefusingHandshake(root, 3, true).create();
    const output = join(root, 'receipt.json');
    const pending = runNativeCommand({
      label: 'handshake-cancel',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '2',
        '--warmups',
        '2',
        '--json',
        '--output',
        output,
      ],
      root: ROOT,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 20,
      pollIntervalMs: 20,
      stream: new DiscardedHandshakeOutput(),
    });
    const barrier = new FakeBenchmarkCancelBarrier(root);
    escapedFixtures.push(...(await barrier.observe(binary, pending)));
    await barrier.release();
    const result = await pending;
    escapedFixtures.push(...result.settlement.survivors);
    expect(await Bun.file(join(root, 'stall-reached')).exists()).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(await Bun.file(`${output}.jsonl`).exists()).toBe(true);
    const events = (await readFile(`${output}.jsonl`, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; phase?: string; status?: string });
    expect(
      events
        .filter((event) => event.kind === 'finished')
        .map(({ phase, status }) => ({ phase, status }))
    ).toEqual([
      { phase: 'warmup', status: 'success' },
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
    expect(progress.attempts).toHaveLength(4);
  }, 30_000);

  it('retains protocol warmups and a successful request before a later failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-handshake-batch-test-'));
    scratch.push(root);
    const binary = await new FakeRuntimeRefusingHandshake(root, 3).create();
    const result = await runNativeCommand({
      label: 'handshake-batch',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '2',
        '--warmups',
        '2',
        '--json',
      ],
      root: ROOT,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      stream: new DiscardedHandshakeOutput(),
    });
    const stdout = await readFile(join(root, 'logs/handshake-batch.stdout.log'), 'utf8');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    const receipt = JSON.parse(stdout) as {
      attempts: Array<{ phase: string; status: string; firstRequestMs: number | null }>;
    };
    expect(receipt.attempts.map(({ phase, status }) => ({ phase, status }))).toEqual([
      { phase: 'warmup', status: 'success' },
      { phase: 'warmup', status: 'success' },
      { phase: 'measured', status: 'success' },
      { phase: 'measured', status: 'failed' },
    ]);
    expect(receipt.attempts[2].firstRequestMs).toBeGreaterThan(0);
  });

  it('retains the failed warmup and stops without silently discarding a broken handshake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-handshake-receipt-test-'));
    scratch.push(root);
    const binary = await new FakeRuntimeRefusingHandshake(root).create();
    const result = await runNativeCommand({
      label: 'handshake-receipt',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '2',
        '--warmups',
        '2',
        '--json',
      ],
      root: ROOT,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      stream: new DiscardedHandshakeOutput(),
    });
    const stdout = await readFile(join(root, 'logs/handshake-receipt.stdout.log'), 'utf8');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(stdout).toContain('Intentional fixture handshake refusal');
    const receipt = JSON.parse(stdout) as {
      complete: boolean;
      phasesMs: { hello: unknown };
      attempts: Array<{ phase: string; status: string; firstRequestMs: number | null }>;
    };
    expect(receipt.complete).toBe(false);
    expect(receipt.phasesMs.hello).toBeNull();
    expect(receipt.attempts).toHaveLength(1);
    expect(receipt.attempts[0]).toMatchObject({
      phase: 'warmup',
      status: 'failed',
      firstRequestMs: null,
    });
  });
});
