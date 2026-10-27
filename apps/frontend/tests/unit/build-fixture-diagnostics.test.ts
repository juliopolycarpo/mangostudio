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
  stops = 0;
  kill(): void {
    this.stops += 1;
    this.resolveExit(143);
  }
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

class ThrowingKillChild extends HeldBuildChild {
  readonly stopFailure = new Error('named stop failure');
  override kill(): void {
    throw this.stopFailure;
  }
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

  test('reports an unconfirmed exit when exit observation rejects', async () => {
    const recording = new RecordingBuildEvents();
    const diagnostics = new BuildFixtureDiagnostics('rejected exit', recording.emit, recording.now);
    const child = new HeldBuildChild();
    const failure = new Error('controlled exit observation failure');
    const observation = diagnostics.observe(child).catch((error: unknown) => error);
    child.rejectExit(failure);
    const result = await observation;
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(failure);
    expect(child.stops).toBe(1);
    expect(child.stdout.locked).toBe(false);
    expect(child.stderr.locked).toBe(false);
    expect(recording.events()).toContainEqual(
      expect.objectContaining({ phase: 'child:exit-rejected', error: String(failure) })
    );
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
  test('diagnostic failures never interrupt child observation or replace its error', async () => {
    const failure = new Error('named stderr failure');
    const child = new HeldBuildChild();
    const throwingEmitter = () => {
      throw new Error('named emitter failure');
    };
    const throwingClock = () => {
      throw new Error('named clock failure');
    };
    const clockFailure = new BuildFixtureDiagnostics(
      'broken clock',
      throwingEmitter,
      throwingClock
    );
    expect(() => clockFailure.record('clock')).not.toThrow();
    let calls = 0;
    const failsAfterStart = () => {
      if (calls++ === 0) return 0;
      throw new Error('late clock failure');
    };
    const lateClock = new BuildFixtureDiagnostics('late clock', () => {}, failsAfterStart);
    expect(() => lateClock.record('clock')).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const serialization = new BuildFixtureDiagnostics(
      'cyclic',
      () => {},
      () => 0
    );
    expect(() => serialization.record('cyclic', cyclic)).not.toThrow();
    const diagnostics = new BuildFixtureDiagnostics('broken emitter', throwingEmitter, () => 0);
    expect(() => diagnostics.record('emit')).not.toThrow();
    const observation = diagnostics.observe(child).catch((error: unknown) => error);
    child.errors.error(failure);
    child.output.close();
    child.resolveExit(1);
    expect(await observation).toBe(failure);
  });

  test('stops and settles held siblings before returning a drain failure', async () => {
    const diagnostics = new BuildFixtureDiagnostics(
      'held siblings',
      () => {},
      () => 0
    );
    const child = new HeldBuildChild();
    const failure = new Error('named held stderr failure');
    const result = diagnostics.observe(child).catch((error: unknown) => error);
    child.errors.error(failure);
    try {
      expect(await result).toBe(failure);
      expect(child.stops).toBe(1);
      expect(child.stdout.locked).toBe(false);
      expect(child.stderr.locked).toBe(false);
    } finally {
      child.resolveExit(143);
      if (!child.stdout.locked) await child.stdout.cancel();
    }
  });

  test('preserves an unprintable drain rejection as the primary error', async () => {
    const recording = new RecordingBuildEvents();
    const diagnostics = new BuildFixtureDiagnostics('unprintable', recording.emit, recording.now);
    const child = new HeldBuildChild();
    const failure: unknown = Object.create(null);
    const result = diagnostics.observe(child).catch((error: unknown) => error);
    child.errors.error(failure);
    expect(await result).toBe(failure);
    expect(recording.events()).toContainEqual(
      expect.objectContaining({ phase: 'stderr:drain-rejected', error: '[unprintable error]' })
    );
  });
  test('retains the stop failure when held child cleanup reaches its deadline', async () => {
    const diagnostics = new BuildFixtureDiagnostics(
      'held exit and failed stop',
      () => {},
      () => 0
    );
    const child = new ThrowingKillChild();
    const primary = new Error('named drain failure');
    const observation = diagnostics.observe(child).catch((error: unknown) => error);
    child.errors.error(primary);
    try {
      const result = await observation;
      expect(result).toBeInstanceOf(AggregateError);
      const [observed, cleanup] = (result as AggregateError).errors;
      expect(observed).toBe(primary);
      expect(cleanup).toBeInstanceOf(AggregateError);
      const errors = (cleanup as AggregateError).errors;
      expect(errors).toContain(child.stopFailure);
      expect(errors.some((error: unknown) => String(error).includes('did not settle'))).toBe(true);
      expect(
        errors.some((error: unknown) => String(error).includes('exit was not confirmed'))
      ).toBe(true);
    } finally {
      child.resolveExit(143);
      await child.exited;
    }
  });
});
