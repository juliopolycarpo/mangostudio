import { describe, expect, it } from 'bun:test';

import {
  cleanupGithubFixtureDirectories,
  type GithubFixtureDirectory,
} from '../support/github-fixture-cleanup';

class HeldFixtureCleanup {
  readonly closing = Promise.withResolvers<void>();
  readonly started: string[] = [];
  readonly gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  readonly thrown = new Map<string, Error>();
  private readonly waiting = new Set<() => void>();
  closeCalls = 0;
  private released = false;

  closeRuntime = (): Promise<void> => {
    this.closeCalls++;
    return this.closing.promise;
  };

  removeDirectory = (path: string): Promise<void> => {
    this.started.push(path);
    const cause = this.thrown.get(path);
    if (cause) throw cause;
    const gate = Promise.withResolvers<void>();
    this.gates.set(path, gate);
    if (this.released) gate.resolve();
    for (const listener of this.waiting) listener();
    return gate.promise;
  };

  gate(path: string): ReturnType<typeof Promise.withResolvers<void>> {
    const gate = this.gates.get(path);
    if (!gate) throw new Error(`expected a started fixture removal | received: ${path}`);
    return gate;
  }

  async waitForStarted(count: number): Promise<void> {
    if (this.started.length >= count) return;
    const ready = Promise.withResolvers<void>();
    const listener = () => {
      if (this.started.length < count) return;
      this.waiting.delete(listener);
      ready.resolve();
    };
    this.waiting.add(listener);
    await ready.promise;
  }

  releaseAll(): void {
    this.released = true;
    this.closing.resolve();
    for (const gate of this.gates.values()) gate.resolve();
  }
}

function fixtures(): GithubFixtureDirectory[] {
  return [
    { role: 'workdir', path: '/controlled/workdir' },
    { role: 'fake-gh-bin', path: '/controlled/bin' },
  ];
}

describe('GitHub fixture cleanup', () => {
  it('closes the runtime first and untracks only completed removals', async () => {
    const directories = fixtures();
    const original = [...directories];
    const cleanup = new HeldFixtureCleanup();
    const operation = cleanupGithubFixtureDirectories(directories, cleanup);
    try {
      expect(cleanup.closeCalls).toBe(1);
      expect(cleanup.started).toEqual([]);
      expect(directories).toEqual(original);
      cleanup.closing.resolve();
      await cleanup.waitForStarted(2);
      cleanup.gate(original[1].path).resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(directories).toEqual([original[0]]);
      cleanup.gate(original[0].path).resolve();
      await operation;
      expect(directories).toEqual([]);
    } finally {
      cleanup.releaseAll();
      await operation;
    }
  });

  it('drains a failed removal before rejecting and retains its role, path and cause', async () => {
    const directories = fixtures();
    const original = [...directories];
    const cleanup = new HeldFixtureCleanup();
    let settled = false;
    const operation = cleanupGithubFixtureDirectories(directories, cleanup).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    );
    void operation.then(() => {
      settled = true;
    });
    const cause = new Error('EBUSY: controlled directory is locked');
    try {
      cleanup.closing.resolve();
      await cleanup.waitForStarted(2);
      cleanup.gate(original[0].path).reject(cause);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled, 'expected cleanup to drain the held bin removal before rejecting').toBe(
        false
      );
      expect(directories).toEqual(original);
      cleanup.gate(original[1].path).resolve();
      const { error } = await operation;
      expect(error).toBeInstanceOf(AggregateError);
      const failure = error as AggregateError;
      expect(failure.errors).toHaveLength(1);
      expect(failure.errors[0].message).toContain('GitHub workdir fixture "/controlled/workdir"');
      expect(failure.errors[0].cause).toBe(cause);
      expect(directories).toEqual([original[0]]);
    } finally {
      cleanup.releaseAll();
      await operation;
    }
  });

  it('retains every fixture without removing one when runtime closure fails', async () => {
    const directories = fixtures();
    const original = [...directories];
    const cleanup = new HeldFixtureCleanup();
    const cause = new Error('controlled runtime did not exit');
    const operation = cleanupGithubFixtureDirectories(directories, cleanup).catch(
      (error: unknown) => error
    );
    cleanup.closing.reject(cause);
    cleanup.releaseAll();
    const error = (await operation) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('expected runtime closure before removal');
    expect(error.message).toContain('/controlled/workdir');
    expect(error.message).toContain('fake-gh-bin');
    expect(cleanup.started).toEqual([]);
    expect(directories).toEqual(original);
  });

  it('drains siblings and aggregates synchronous and asynchronous removal failures in input order', async () => {
    const directories = fixtures();
    const original = [...directories];
    const cleanup = new HeldFixtureCleanup();
    const first = new Error('controlled synchronous refusal');
    const second = new Error('controlled asynchronous refusal');
    cleanup.thrown.set(original[0].path, first);
    const operation = cleanupGithubFixtureDirectories(directories, cleanup).catch(
      (error: unknown) => error
    );
    try {
      cleanup.closing.resolve();
      await cleanup.waitForStarted(2);
      cleanup.gate(original[1].path).reject(second);
      const error = (await operation) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors.map((failure: Error) => failure.cause)).toEqual([first, second]);
      expect(error.errors[1].message).toContain('GitHub fake-gh-bin fixture "/controlled/bin"');
      expect(directories).toEqual(original);
    } finally {
      cleanup.releaseAll();
      await operation;
    }
  });

  it('still closes the runtime when there are no directories', async () => {
    const cleanup = new HeldFixtureCleanup();
    const operation = cleanupGithubFixtureDirectories([], cleanup);
    cleanup.closing.resolve();
    await operation;
    expect(cleanup.closeCalls).toBe(1);
    expect(cleanup.started).toEqual([]);
  });
});
