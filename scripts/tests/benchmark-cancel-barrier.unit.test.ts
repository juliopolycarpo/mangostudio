import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runNativeCommand } from '../lib/native-bun-qualification-process';
import { FakeBenchmarkCancelBarrier } from './support/benchmark-cancel-barrier';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
class DiscardedBarrierOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}
class FakeEarlyBenchmarkExit {
  readonly command = [
    process.execPath,
    '-e',
    'console.log("fixture stdout before early exit"); console.error("fixture stderr before early exit"); process.exit(7);',
  ];
}
describe('benchmark cancellation barrier diagnostics', () => {
  it('reports early command exit and both output streams instead of implying a deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-early-exit-test-'));
    scratch.push(root);
    const fixture = new FakeEarlyBenchmarkExit();
    const pending = runNativeCommand({
      label: 'early-benchmark-exit',
      command: fixture.command,
      root,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 10,
      pollIntervalMs: 20,
      stream: new DiscardedBarrierOutput(),
    });
    const barrier = new FakeBenchmarkCancelBarrier(root);
    const error = await barrier.observe('missing-fixture', pending).then(
      () => null,
      (error: unknown) => String(error)
    );
    expect(error).toContain('expected started barrier');
    expect(error).toContain('exitCode=7, signal=null, timedOut=false');
    expect(error).toContain('fixture stdout before early exit');
    expect(error).toContain('fixture stderr before early exit');
    expect((await pending).settlement.empty).toBe(true);
  });
});
