import { expect, it } from 'bun:test';
import { probeRuntimeBinary } from '../../../src/cli/runtime-binary-probe';

class RetainedRuntimeOutput {
  readonly root = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });
  readonly producer = Bun.spawn(
    [process.execPath, '-e', "process.stdout.write('1.2.3\\n'); setInterval(() => {}, 1000)"],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true }
  );

  spawn = () => ({
    stdout: this.producer.stdout,
    exited: this.root.exited,
    kill: (signal?: 'SIGKILL') => this.root.kill(signal),
  });

  async dispose(): Promise<void> {
    this.root.kill('SIGKILL');
    this.producer.kill('SIGKILL');
    await Promise.all([this.root.exited, this.producer.exited]);
  }
}

// Both processes are directly owned by the test. The live producer represents
// an inherited stdout pipe retained after a version process has already exited.
it('cancels real retained output after the runtime root has exited successfully', async () => {
  const fixture = new RetainedRuntimeOutput();
  try {
    expect(await fixture.root.exited).toBe(0);
    expect(fixture.producer.exitCode).toBeNull();
    const started = performance.now();
    const result = await probeRuntimeBinary(process.execPath, fixture.spawn);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(result.version).toBeNull();
    expect(result.error).toBe('runtime --version timed out after 5000 ms');
    expect(fixture.producer.stdout.locked).toBe(false);
  } finally {
    await fixture.dispose();
  }
  expect(fixture.producer.exitCode !== null || fixture.producer.signalCode !== null).toBe(true);
}, 15_000);
