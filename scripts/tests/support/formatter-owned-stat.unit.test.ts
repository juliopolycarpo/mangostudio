import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  type FormatterStatHost,
  FormatterStatReadExpiry,
  readOwnedFormatterStat,
} from './formatter-owned-stat';

class ControlledStatHost implements FormatterStatHost {
  readonly controller = new AbortController();
  readonly reason = new Error('controlled private stat deadline');
  readonly calls: Array<[number, AbortSignal]> = [];
  readonly budgets: number[] = [];
  readonly cleanupBudgets: number[] = [];
  cleanupCanceled = 0;
  cleanup!: () => void;
  registerWatchdog!: () => void;
  readonly watchdogReady = new Promise<void>((resolve) => {
    this.registerWatchdog = resolve;
  });
  resolve!: (value: string) => void;
  reject!: (error: unknown) => void;
  readonly result = new Promise<string>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  timeout(ms: number): AbortSignal {
    this.budgets.push(ms);
    return this.controller.signal;
  }
  read(pid: number, signal: AbortSignal): Promise<string> {
    this.calls.push([pid, signal]);
    return this.result;
  }
  watchdog(callback: () => void, ms: number): () => void {
    this.cleanup = callback;
    this.cleanupBudgets.push(ms);
    this.registerWatchdog();
    return () => {
      this.cleanupCanceled++;
    };
  }
  expire(): void {
    this.controller.abort(this.reason);
  }
}

/** Real Bun stat I/O with a deterministically expired private signal. */
class RealAbortedStatHost implements FormatterStatHost {
  readonly controller = new AbortController();
  readonly reason = new DOMException('controlled stat deadline', 'TimeoutError');
  readonly calls: Array<[number, AbortSignal]> = [];

  constructor() {
    this.controller.abort(this.reason);
  }
  timeout(): AbortSignal {
    return this.controller.signal;
  }
  read(pid: number, signal: AbortSignal): Promise<string> {
    this.calls.push([pid, signal]);
    return readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
  }
  watchdog(callback: () => void, ms: number): () => void {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  }
}

function abortFailure(cause: unknown): Error {
  return Object.assign(new Error('The operation was aborted', { cause }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}
function ioFailure(code: string): Error {
  return Object.assign(new Error(`controlled ${code} stat failure`), { code });
}

describe('owned formatter stat read', () => {
  it.skipIf(process.platform !== 'linux')(
    'reads the current Linux process through the native adapter',
    async () => {
      const stat = await readOwnedFormatterStat(process.pid, 300);
      expect(stat?.startsWith(`${process.pid} (`)).toBe(true);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'retains the actual Bun stat abort and its private timeout reason',
    async () => {
      const host = new RealAbortedStatHost();
      const error = await readOwnedFormatterStat(process.pid, 5, host).catch(
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(FormatterStatReadExpiry);
      expect(error).toMatchObject({ pid: process.pid, timeoutMs: 5, reason: host.reason });
      const original = (error as FormatterStatReadExpiry).cause as NodeJS.ErrnoException;
      expect(original).toBeInstanceOf(Error);
      expect(original.name).toBe('AbortError');
      expect(original.code).toBe('ABORT_ERR');
      expect(original.cause).toBe(host.controller.signal.reason);
      expect(host.calls).toEqual([[process.pid, host.controller.signal]]);
    }
  );

  it('classifies only the matching private abort before read settlement', async () => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host).catch((error: unknown) => error);
    host.expire();
    const original = abortFailure(host.reason);
    host.reject(original);
    const error = await running;
    expect(error).toBeInstanceOf(FormatterStatReadExpiry);
    expect(error).toMatchObject({ pid: 1234, timeoutMs: 5, reason: host.reason, cause: original });
    expect(host.calls).toEqual([[1234, host.controller.signal]]);
    expect(host.budgets).toEqual([5]);
  });
  it('retains a successful read before expiry and ignores a later private abort', async () => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.resolve('captured stat');
    expect(await running).toBe('captured stat');
    host.expire();
    expect(host.cleanupBudgets).toEqual([]);
  });
  it('rejects a successful stat read after private expiry', async () => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.expire();
    host.resolve('late stat');
    await expect(running).rejects.toThrow('expected stat read before its private deadline');
  });
  it.each(['ENOENT', 'ESRCH'])('accepts %s absence only before expiry', async (code) => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.reject(ioFailure(code));
    expect(await running).toBeUndefined();
    host.expire();
  });
  it.each(['ENOENT', 'ESRCH'])('retains a %s failure after expiry', async (code) => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.expire();
    const error = ioFailure(code);
    host.reject(error);
    await expect(running).rejects.toBe(error);
  });
  it.each(['EACCES', 'EIO'])('retains an independent %s failure after expiry', async (code) => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.expire();
    const error = ioFailure(code);
    host.reject(error);
    await expect(running).rejects.toBe(error);
  });
  it.each(['EACCES', 'EIO'])('retains an independent %s failure before expiry', async (code) => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    const error = ioFailure(code);
    host.reject(error);
    await expect(running).rejects.toBe(error);
    host.expire();
  });
  it.each([null, undefined, 'opaque stat failure'])(
    'retains a non-Error stat rejection %j before expiry',
    async (failure) => {
      const host = new ControlledStatHost();
      const running = readOwnedFormatterStat(1234, 5, host).then(
        () => 'unexpected success',
        (error: unknown) => error
      );
      host.reject(failure);
      expect(await running).toBe(failure);
    }
  );
  it('freezes a settled failure before a later private abort', async () => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    const error = abortFailure(host.reason);
    host.reject(error);
    await expect(running).rejects.toBe(error);
    host.expire();
    expect(host.cleanupBudgets).toEqual([]);
  });
  it('retains a foreign AbortError after private expiry', async () => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.expire();
    const error = abortFailure(new Error('foreign abort reason'));
    host.reject(error);
    await expect(running).rejects.toBe(error);
  });
  it.each(['wrong name', 'wrong code'])('retains an abort-shaped failure with %s', async (mode) => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.expire();
    const error = abortFailure(host.reason);
    if (mode === 'wrong name') error.name = 'Error';
    else Object.assign(error, { code: 'EIO' });
    host.reject(error);
    await expect(running).rejects.toBe(error);
  });
  it('reports an unsettled read after bounded cleanup and observes a later rejection', async () => {
    const host = new ControlledStatHost();
    const running = readOwnedFormatterStat(1234, 5, host);
    host.expire();
    await host.watchdogReady;
    expect(host.cleanupBudgets).toEqual([300]);
    host.cleanup();
    const error = await running.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FormatterStatReadExpiry);
    expect((error as Error).message).toContain('stat read did not settle within 300ms');
    host.reject(new Error('controlled late rejection'));
    await Promise.resolve();
  });
});
