import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runNativeCommand } from '../lib/native-bun-qualification-process';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
class DiscardedMachineOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}
/** Static program, with its structured payload size supplied through argv. */
class FakeMachineCommand {
  constructor(
    private readonly payloadBytes: number,
    private readonly output: 'stdout' | 'stderr' = 'stdout'
  ) {}
  readonly source =
    'const size = Number(process.argv[1]); const json = JSON.stringify({ packages: [{ name: "fixture", description: "x".repeat(size) }], workspace_members: ["fixture"] }); await Bun.write(process.argv[2] === "stderr" ? Bun.stderr : Bun.stdout, json + "\\n");';
  command(): string[] {
    return [process.execPath, '-e', this.source, String(this.payloadBytes), this.output];
  }
}
describe('native command machine stdout', () => {
  it('rejects an invalid explicit limit before creating command logs or launching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-machine-invalid-'));
    scratch.push(root);
    const fixture = new FakeMachineCommand(1);
    await expect(
      runNativeCommand({
        label: 'invalid-bound',
        command: fixture.command(),
        root,
        out: root,
        env: { ...process.env },
        timeoutSeconds: 10,
        stream: new DiscardedMachineOutput(),
        machineStdout: { maxLineBytes: 16 * 2 ** 20 + 1 },
      })
    ).rejects.toThrow('expected a positive safe integer');
    expect(await Bun.file(join(root, 'logs/invalid-bound.stdout.log')).exists()).toBe(false);
  });

  it('keeps stderr under the default text bound when machine stdout is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-machine-stderr-'));
    scratch.push(root);
    const fixture = new FakeMachineCommand(2 * 2 ** 20, 'stderr');
    const result = await runNativeCommand({
      label: 'stderr-default',
      command: fixture.command(),
      root,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 10,
      pollIntervalMs: 20,
      stream: new DiscardedMachineOutput(),
      machineStdout: { maxLineBytes: 4 * 2 ** 20 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.settlement.empty).toBe(true);
    expect(result.errors).toContain(
      'Output line exceeds 1 MiB; expected bounded text reporter lines'
    );
  });

  it('keeps default text rejection for oversized single-line output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-default-output-'));
    scratch.push(root);
    const fixture = new FakeMachineCommand(2 * 2 ** 20);
    const result = await runNativeCommand({
      label: 'text-default',
      command: fixture.command(),
      root,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 10,
      pollIntervalMs: 20,
      stream: new DiscardedMachineOutput(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.settlement.empty).toBe(true);
    expect(result.errors).toContain(
      'Output line exceeds 1 MiB; expected bounded text reporter lines'
    );
  });
  it('captures complete oversized metadata only with an explicit bounded machine stdout limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-machine-output-'));
    scratch.push(root);
    const fixture = new FakeMachineCommand(2 * 2 ** 20);
    const result = await runNativeCommand({
      label: 'metadata-bounded',
      command: fixture.command(),
      root,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 10,
      pollIntervalMs: 20,
      stream: new DiscardedMachineOutput(),
      machineStdout: { maxLineBytes: 4 * 2 ** 20 },
    });
    const raw = await readFile(join(root, 'logs/metadata-bounded.stdout.log'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(result.exitCode).toBe(0);
    expect(result.settlement.empty).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.machineStdoutMaxLineBytes).toBe(4 * 2 ** 20);
    expect(parsed.packages[0].description).toHaveLength(2 * 2 ** 20);
    expect(parsed.workspace_members).toEqual(['fixture']);
  });
  it('retains a command error when machine stdout exceeds its explicit limit, even in one chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-machine-limit-'));
    scratch.push(root);
    const fixture = new FakeMachineCommand(128);
    const result = await runNativeCommand({
      label: 'metadata-too-large',
      command: fixture.command(),
      root,
      out: root,
      env: { ...process.env },
      timeoutSeconds: 10,
      pollIntervalMs: 20,
      stream: new DiscardedMachineOutput(),
      machineStdout: { maxLineBytes: 64 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.settlement.empty).toBe(true);
    expect(
      result.errors.some((message) =>
        message.includes('Machine stdout line: expected <= 64 UTF-8 bytes')
      )
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, 'logs/metadata-too-large.stdout.log'), 'utf8'))
        .packages[0].description
    ).toHaveLength(128);
  });
});
