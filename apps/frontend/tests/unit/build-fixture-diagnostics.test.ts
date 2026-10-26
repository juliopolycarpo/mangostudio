import { describe, expect, test } from 'bun:test';
import { BuildFixtureDiagnostics } from '../support/build-fixture-diagnostics';

class RecordingBuildEvents {
  readonly lines: string[] = [];
  time = 100;
  private readonly waiters = new Map<string, (() => void)[]>();
  readonly emit = (line: string): void => {
    this.lines.push(line);
    const phase = String(JSON.parse(line.slice('[build-fixture] '.length)).phase);
    for (const resolve of this.waiters.get(phase) ?? []) resolve();
    this.waiters.delete(phase);
  };
  readonly now = (): number => this.time;

  waitFor(phase: string): Promise<void> {
    if (this.events().some((event) => event.phase === phase)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.set(phase, [...(this.waiters.get(phase) ?? []), resolve]);
    });
  }

  events(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line.slice('[build-fixture] '.length)));
  }
}

class HeldBuildChild {
  readonly pid = 6712;
  signalCode: string | number | null = null;
  resolveExit!: (code: number) => void;
  rejectExit!: (error: Error) => void;
  readonly exited = new Promise<number>((resolve, reject) => {
    this.resolveExit = resolve;
    this.rejectExit = reject;
  });
  output!: ReadableStreamDefaultController<Uint8Array>;
  errors!: ReadableStreamDefaultController<Uint8Array>;
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.output = controller;
    },
  });
  readonly stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.errors = controller;
    },
  });
}

describe('build fixture diagnostics', () => {
  test('emits phase context immediately using the fixture clock', () => {
    const recording = new RecordingBuildEvents();
    const diagnostics = new BuildFixtureDiagnostics(
      'controlled copy',
      recording.emit,
      recording.now
    );
    recording.time = 125;
    diagnostics.record('fixture:frontend-copy-started');
    expect(recording.events()).toEqual([
      {
        fixture: 'controlled copy',
        phase: 'fixture:frontend-copy-started',
        elapsedMs: 25,
        workerPid: process.pid,
        platform: process.platform,
        bun: Bun.version,
      },
    ]);
  });

  test('reports exit while a drain is held, then retains complete split UTF-8 output', async () => {
    const recording = new RecordingBuildEvents();
    const diagnostics = new BuildFixtureDiagnostics('held drain', recording.emit, recording.now);
    const child = new HeldBuildChild();
    let completed = false;
    const observation = diagnostics.observe(child).then((result) => {
      completed = true;
      return result;
    });
    try {
      child.output.enqueue(new Uint8Array([0xe2, 0x82]));
      child.output.enqueue(new Uint8Array([0xac]));
      child.output.close();
      child.signalCode = 'SIGTERM';
      child.resolveExit(143);
      await child.exited;
      expect(recording.events()).toContainEqual(
        expect.objectContaining({
          phase: 'child:exited',
          childPid: 6712,
          exitCode: 143,
          signal: 'SIGTERM',
        })
      );
      expect(completed).toBe(false);
      expect(recording.events().some((event) => event.phase === 'stderr:drained')).toBe(false);
    } finally {
      child.errors.enqueue(new TextEncoder().encode('controlled compiler error'));
      child.errors.close();
      child.resolveExit(143);
      await observation;
    }
    expect(await observation).toEqual({
      exitCode: 143,
      stdout: '€',
      stderr: 'controlled compiler error',
    });
    expect(recording.events()).toContainEqual(
      expect.objectContaining({ phase: 'stdout:drained', bytes: 3, text: '€' })
    );
    expect(recording.events().at(-1)?.phase).toBe('child:observations-complete');
    expect(child.stdout.locked).toBe(false);
    expect(child.stderr.locked).toBe(false);
  });

  test('preserves an exit observation rejection and still records later stream settlement', async () => {
    const recording = new RecordingBuildEvents();
    const diagnostics = new BuildFixtureDiagnostics('rejected exit', recording.emit, recording.now);
    const child = new HeldBuildChild();
    const failure = new Error('controlled exit observation failure');
    const observation = diagnostics.observe(child).catch((error: unknown) => error);
    child.rejectExit(failure);
    try {
      expect(await observation).toBe(failure);
      expect(recording.events()).toContainEqual(
        expect.objectContaining({ phase: 'child:exit-rejected', error: String(failure) })
      );
    } finally {
      child.output.close();
      child.errors.close();
      await Promise.all([recording.waitFor('stdout:drained'), recording.waitFor('stderr:drained')]);
    }
    expect(
      recording.events().filter((event) => String(event.phase).endsWith(':drained'))
    ).toHaveLength(2);
    expect(recording.events().some((event) => event.phase === 'child:observations-complete')).toBe(
      false
    );
  });

  test('preserves a drain rejection with its partial output and observed child exit', async () => {
    const recording = new RecordingBuildEvents();
    const diagnostics = new BuildFixtureDiagnostics(
      'rejected drain',
      recording.emit,
      recording.now
    );
    const child = new HeldBuildChild();
    const failure = new Error('controlled stderr read failure');
    const observation = diagnostics.observe(child).catch((error: unknown) => error);
    child.errors.enqueue(new TextEncoder().encode('partial'));
    await recording.waitFor('stderr:chunk');
    child.errors.error(failure);
    child.output.close();
    child.resolveExit(1);
    expect(await observation).toBe(failure);
    await recording.waitFor('stdout:drained');
    expect(recording.events()).toContainEqual(
      expect.objectContaining({
        phase: 'stderr:drain-rejected',
        bytes: 7,
        text: 'partial',
        error: String(failure),
      })
    );
    expect(recording.events()).toContainEqual(
      expect.objectContaining({ phase: 'child:exited', exitCode: 1, signal: null })
    );
    expect(child.stdout.locked).toBe(false);
    expect(child.stderr.locked).toBe(false);
  });
});
