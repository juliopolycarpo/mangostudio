import { describe, expect, it } from 'bun:test';

import {
  FormatterQueryExpiry,
  type FormatterQueryHost,
  queryOwnedFormatterProcess,
} from './formatter-owned-query';
import {
  type FormatterNativeQueries,
  readNativeFormatterProcess,
} from './formatter-process-settlement';

class ControlledQueryChild {
  signalCode: NodeJS.Signals | number | null = null;
  killed = false;
  stopCalls = 0;
  stopFailure?: Error;
  cancelFailure?: Error;
  holdCancellation?: Promise<void>;
  kill(): void {
    this.stopCalls += 1;
    if (this.stopFailure) throw this.stopFailure;
  }
  resolve!: (code: number) => void;
  reject!: (error: Error) => void;
  readonly exited = new Promise<number>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  output!: ReadableStreamDefaultController<Uint8Array>;
  errors!: ReadableStreamDefaultController<Uint8Array>;
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (stream) => {
      this.output = stream;
    },
    cancel: () =>
      this.cancelFailure
        ? Promise.reject(this.cancelFailure)
        : (this.holdCancellation ?? Promise.resolve()),
  });
  readonly stderr = new ReadableStream<Uint8Array>({
    start: (stream) => {
      this.errors = stream;
    },
  });
}

/** Native-looking lifecycle events without launching or signaling a process. */
class ControlledQueryHost implements FormatterQueryHost {
  readonly controller = new AbortController();
  readonly reason = new Error('controlled private observation budget');
  readonly child = new ControlledQueryChild();
  readonly calls: Array<[number, AbortSignal]> = [];
  readonly budgets: number[] = [];
  listeners = 0;
  detach!: () => void;
  readonly detached = new Promise<void>((resolve) => {
    this.detach = resolve;
  });
  spawnFailure: Error | undefined;
  expireOnSpawn = false;
  onExit!: (error?: Error) => void;

  constructor() {
    const signal = this.controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => {
      this.listeners++;
      add(...args);
    };
    signal.removeEventListener = (...args) => {
      if (this.listeners) this.listeners--;
      remove(...args);
      this.detach();
    };
  }

  timeout(timeoutMs: number): AbortSignal {
    this.budgets.push(timeoutMs);
    return this.controller.signal;
  }

  spawn(pid: number, signal: AbortSignal, onExit: (error?: Error) => void): ControlledQueryChild {
    this.calls.push([pid, signal]);
    this.onExit = onExit;
    if (this.expireOnSpawn) this.expire();
    if (this.spawnFailure) throw this.spawnFailure;
    return this.child;
  }

  expire(): void {
    this.controller.abort(this.reason);
  }
  exit(code = 143, signal: NodeJS.Signals | number | null = 'SIGTERM', error?: Error): void {
    this.child.signalCode = signal;
    this.child.killed = code !== 0;
    this.onExit(error);
    this.child.resolve(code);
  }
  close(): void {
    this.child.output.close();
    this.child.errors.close();
  }
}

/** Drive the public native reader through the owned query without an OS subprocess. */
class ControlledNativeAdapter implements FormatterNativeQueries {
  readonly platform = 'darwin' as const;
  readonly host = new ControlledQueryHost();
  readStat(): Promise<string | undefined> {
    throw new Error('unexpected Linux stat');
  }
  query(pid: number, timeoutMs: number) {
    return queryOwnedFormatterProcess(pid, timeoutMs, this.host);
  }
}

/** Real Bun child used only to verify private abort and onExit ordering on this host. */
class RealAbortQueryHost implements FormatterQueryHost {
  timeout(timeoutMs: number): AbortSignal {
    return AbortSignal.timeout(Math.min(timeoutMs, 10));
  }
  spawn(_pid: number, signal: AbortSignal, onExit: (error?: Error) => void) {
    return Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      killSignal: 'SIGTERM',
      onExit(_child, _code, _signal, error) {
        onExit(error);
      },
    });
  }
}

describe('owned formatter native query', () => {
  it('classifies only its private budget event before an empty SIGTERM exit', async () => {
    const host = new ControlledQueryHost();
    const result = queryOwnedFormatterProcess(1234, 2, host).catch((error: unknown) => error);
    host.expire();
    host.exit();
    host.close();
    const error = await result;
    expect(error).toBeInstanceOf(FormatterQueryExpiry);
    expect(error).toMatchObject({
      pid: 1234,
      timeoutMs: 2,
      name: 'FormatterQueryExpiry',
      cause: host.reason,
    });
    expect((error as FormatterQueryExpiry).cause).toBe(host.reason);
    expect(host.budgets).toEqual([2]);
    expect(host.calls).toEqual([[1234, host.controller.signal]]);
    expect(host.listeners).toBe(0);
  });

  it('does not infer ownership from an arbitrary SIGTERM exit or killed flag', async () => {
    const host = new ControlledQueryHost();
    const result = queryOwnedFormatterProcess(1234, 2, host);
    host.exit();
    host.close();
    expect(await result).toMatchObject({ exitCode: 143, signalCode: 'SIGTERM', killed: true });
    expect(host.listeners).toBe(0);
  });

  it('freezes on exit before a late abort while output remains held', async () => {
    const host = new ControlledQueryHost();
    const result = queryOwnedFormatterProcess(1234, 2, host);
    host.exit();
    host.expire();
    host.close();
    expect(await result).toMatchObject({ exitCode: 143 });
    expect(host.listeners).toBe(0);
  });

  it.each(['before', 'after'] as const)(
    'preserves wait rejection %s the private event',
    async (order) => {
      const host = new ControlledQueryHost();
      const failure = new Error('controlled independent wait refusal');
      const result = queryOwnedFormatterProcess(1234, 2, host).catch((error: unknown) => error);
      if (order === 'after') host.expire();
      host.child.reject(failure);
      // Observe the rejection handler before delivering the deliberately late budget event.
      await host.detached;
      if (order === 'before') host.expire();
      host.close();
      const received = await result;
      expect(received).toBeInstanceOf(AggregateError);
      expect((received as AggregateError).errors).toContain(failure);
      expect(
        (received as AggregateError).errors.some((error: unknown) =>
          String(error).includes('exit was not confirmed')
        )
      ).toBe(true);
      expect(host.listeners).toBe(0);
    }
  );

  it.each(['before', 'after'] as const)(
    'preserves stream refusal %s the private event',
    async (order) => {
      const host = new ControlledQueryHost();
      const failure = new Error('controlled independent stream refusal');
      const result = queryOwnedFormatterProcess(1234, 2, host).catch((error: unknown) => error);
      if (order === 'after') host.expire();
      host.child.errors.error(failure);
      await host.detached;
      if (order === 'before') host.expire();
      host.exit();
      host.child.output.close();
      expect(await result).toBe(failure);
      expect(host.listeners).toBe(0);
    }
  );

  it('keeps a spawn failure even when the private budget event coexists', async () => {
    const host = new ControlledQueryHost();
    host.spawnFailure = new Error('controlled native spawn refusal');
    host.expireOnSpawn = true;
    const result = queryOwnedFormatterProcess(1234, 2, host).catch((error: unknown) => error);
    expect(await result).toBe(host.spawnFailure);
    expect(host.listeners).toBe(0);
  });

  it('keeps onExit errors and all independent stream/wait causes', async () => {
    const host = new ControlledQueryHost();
    const exitError = new Error('controlled native onExit refusal');
    const waitError = new Error('controlled native wait refusal');
    const streamError = new Error('controlled native read refusal');
    const result = queryOwnedFormatterProcess(1234, 2, host).catch((error: unknown) => error);
    host.expire();
    host.onExit(exitError);
    host.child.reject(waitError);
    host.child.errors.error(streamError);
    host.child.output.close();
    const failure = await result;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(4);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([exitError, waitError, streamError])
    );
    expect(host.listeners).toBe(0);
  });

  it('rejects an empty exit after the private deadline instead of reporting absence', async () => {
    const adapter = new ControlledNativeAdapter();
    const observation = readNativeFormatterProcess(1234, 300, adapter).catch(
      (error: unknown) => error
    );
    adapter.host.expire();
    adapter.host.exit(1, null);
    adapter.host.close();
    const received = await observation;
    expect(received).toBeInstanceOf(Error);
    expect(received).not.toBeInstanceOf(FormatterQueryExpiry);
    expect((received as Error).cause).toBe(adapter.host.reason);
    expect(received).toMatchObject({
      pid: 1234,
      timeoutMs: 300,
      result: { exitCode: 1, stdout: '', stderr: '' },
    });
    expect(String(received)).toContain('exitCode');
  });

  it.each(['output', 'stderr', 'other signal', 'ordinary exit', 'identity'] as const)(
    'rejects %s after private expiry without classifying it as owned SIGTERM expiry',
    async (mode) => {
      const host = new ControlledQueryHost();
      const result = queryOwnedFormatterProcess(1234, 2, host).catch((error: unknown) => error);
      host.expire();
      if (mode === 'output') host.child.output.enqueue(new TextEncoder().encode('native output'));
      if (mode === 'stderr')
        host.child.errors.enqueue(new TextEncoder().encode('permission refused'));
      if (mode === 'identity')
        host.child.output.enqueue(
          new TextEncoder().encode('1234 100 1234 S Tue Oct 27 10:00:00 2026 formatter')
        );
      host.exit(
        mode === 'ordinary exit' ? 1 : mode === 'identity' ? 0 : 143,
        mode === 'other signal' ? 'SIGKILL' : 'SIGTERM'
      );
      host.close();
      const received = await result;
      expect(received).toBeInstanceOf(Error);
      expect(received).not.toBeInstanceOf(FormatterQueryExpiry);
      expect(received).toMatchObject({
        pid: 1234,
        timeoutMs: 2,
        cause: host.reason,
        result: {
          exitCode: mode === 'ordinary exit' ? 1 : mode === 'identity' ? 0 : 143,
          signalCode: mode === 'other signal' ? 'SIGKILL' : 'SIGTERM',
        },
      });
      if (mode === 'output') expect(received).toHaveProperty('result.stdout', 'native output');
      if (mode === 'stderr') expect(received).toHaveProperty('result.stderr', 'permission refused');
      if (mode === 'identity')
        expect(received).toHaveProperty(
          'result.stdout',
          '1234 100 1234 S Tue Oct 27 10:00:00 2026 formatter'
        );
      expect(host.listeners).toBe(0);
    }
  );
  it('bounds a read failure while the child exit and sibling drain remain held', async () => {
    const host = new ControlledQueryHost();
    const failure = new Error('named held sibling read refusal');
    const observation = queryOwnedFormatterProcess(1234, 10, host).catch((error: unknown) => error);
    host.child.errors.error(failure);
    let finished = false;
    void observation.then(() => {
      finished = true;
    });
    try {
      await Promise.race([observation, Bun.sleep(1000)]);
      expect(finished).toBe(true);
      const result = await observation;
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toContain(failure);
      expect(host.child.stopCalls).toBeGreaterThan(0);
    } finally {
      host.exit(143, 'SIGTERM');
      try {
        host.child.output.close();
      } catch {
        /* The bounded cleanup may already have cancelled this stream. */
      }
      await observation;
    }
  });

  it('bounds a held drain even after the child has exited', async () => {
    const host = new ControlledQueryHost();
    const observation = queryOwnedFormatterProcess(1234, 10, host).catch((error: unknown) => error);
    host.exit(0, null);
    host.child.errors.close();
    let finished = false;
    void observation.then(() => {
      finished = true;
    });
    try {
      await Promise.race([observation, Bun.sleep(1000)]);
      expect(finished).toBe(true);
      expect(await observation).toBeInstanceOf(Error);
    } finally {
      try {
        host.child.output.close();
      } catch {
        /* The bounded cleanup may already have cancelled this stream. */
      }
      await observation;
    }
  });

  it('retains independent read, stop, cancel and unconfirmed exit failures', async () => {
    const host = new ControlledQueryHost();
    const failure = new Error('named independent read refusal');
    host.child.stopFailure = new Error('named stop refusal');
    host.child.cancelFailure = new Error('named cancellation refusal');
    const result = queryOwnedFormatterProcess(1234, 10, host).catch((error: unknown) => error);
    host.child.errors.error(failure);
    try {
      const received = await result;
      expect(received).toBeInstanceOf(AggregateError);
      expect((received as AggregateError).errors).toEqual(
        expect.arrayContaining([failure, host.child.stopFailure, host.child.cancelFailure])
      );
      expect(
        (received as AggregateError).errors.some((error: unknown) =>
          String(error).includes('exit was not confirmed')
        )
      ).toBe(true);
      expect(received).not.toBeInstanceOf(FormatterQueryExpiry);
    } finally {
      host.exit(143, 'SIGTERM');
      try {
        host.child.output.close();
      } catch {
        /* The bounded cleanup may already have cancelled this stream. */
      }
    }
  });

  it('does not classify a private abort with a held exit as successful expiry', async () => {
    const host = new ControlledQueryHost();
    const result = queryOwnedFormatterProcess(1234, 10, host).catch((error: unknown) => error);
    host.expire();
    try {
      const received = await result;
      expect(received).not.toBeInstanceOf(FormatterQueryExpiry);
      expect(received).toBeInstanceOf(AggregateError);
      expect(
        (received as AggregateError).errors.some((error: unknown) =>
          String(error).includes('observation incomplete')
        )
      ).toBe(true);
      expect(
        (received as AggregateError).errors.some((error: unknown) =>
          String(error).includes('exit was not confirmed')
        )
      ).toBe(true);
    } finally {
      host.exit(143, 'SIGTERM');
      try {
        host.child.output.close();
      } catch {
        /* The bounded cleanup may already have cancelled this stream. */
      }
      try {
        host.child.errors.close();
      } catch {
        /* The bounded cleanup may already have cancelled this stream. */
      }
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'observes a real Bun private abort and SIGTERM exit on Linux',
    async () => {
      const received = await queryOwnedFormatterProcess(
        process.pid,
        50,
        new RealAbortQueryHost()
      ).catch((error: unknown) => error);
      expect(received).toBeInstanceOf(FormatterQueryExpiry);
      expect((received as FormatterQueryExpiry).result).toMatchObject({
        exitCode: 143,
        signalCode: 'SIGTERM',
        stdout: '',
        stderr: '',
      });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'queries its own process through the real POSIX ps adapter',
    async () => {
      const result = await queryOwnedFormatterProcess(process.pid, 300);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split(/\s+/)[0]).toBe(String(process.pid));
      expect(result.stderr).toBe('');
    }
  );

  it('reports an unconfirmed held reader cancellation within the separate cleanup budget', async () => {
    const host = new ControlledQueryHost();
    let release!: () => void;
    host.child.holdCancellation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = queryOwnedFormatterProcess(1234, 10, host).catch((error: unknown) => error);
    host.exit(0, null);
    host.child.errors.close();
    try {
      const received = await result;
      expect(received).toBeInstanceOf(AggregateError);
      expect(
        (received as AggregateError).errors.some((error: unknown) =>
          String(error).includes('observation incomplete')
        )
      ).toBe(true);
      expect(
        (received as AggregateError).errors.some((error: unknown) =>
          String(error).includes('cleanup did not settle')
        )
      ).toBe(true);
      expect(received).not.toBeInstanceOf(FormatterQueryExpiry);
    } finally {
      release();
      try {
        host.child.output.close();
      } catch {
        /* The bounded cleanup may already have cancelled this stream. */
      }
    }
  });
  it('settles the owned child when reader acquisition fails', async () => {
    const host = new ControlledQueryHost();
    const lockedReader = host.child.stdout.getReader();
    const result = queryOwnedFormatterProcess(1234, 10, host).catch((error: unknown) => error);
    try {
      await host.detached;
      const returnedBeforeExit = await Promise.race([
        result.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(returnedBeforeExit).toBe(false);
      expect(host.child.stopCalls).toBe(1);
      host.exit(0, null);
      try {
        host.child.errors.close();
      } catch {
        /* Cleanup may already have cancelled this stream. */
      }
      expect(await result).toBeInstanceOf(TypeError);
      expect(host.child.stderr.locked).toBe(false);
    } finally {
      host.exit(0, null);
      try {
        host.child.errors.close();
      } catch {
        /* Cleanup may already have cancelled the stream. */
      }
      lockedReader.releaseLock();
      try {
        host.child.output.close();
      } catch {
        /* Cleanup may already have closed the stream. */
      }
    }
  });
});
