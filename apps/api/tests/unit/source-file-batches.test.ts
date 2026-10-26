import { describe, expect, it } from 'bun:test';
import { readSourceFileBatches } from '../support/source-file-batches';

class HeldFileReader {
  readonly started: string[] = [];
  readonly completed: string[] = [];
  active = 0;
  peak = 0;
  readonly thrown = new Map<string, Error>();
  private readonly gates = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
  private readonly waiting = new Set<() => void>();
  private released = false;

  constructor(private readonly paths: readonly string[]) {}

  read = (path: string): Promise<string> => {
    if (!this.paths.includes(path))
      throw new Error(`expected a requested neutral path | received: ${path}`);
    this.started.push(path);
    const thrown = this.thrown.get(path);
    if (thrown) throw thrown;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    const gate = Promise.withResolvers<string>();
    this.gates.set(path, gate);
    if (this.released) gate.resolve(`neutral text ${path}`);
    this.notify();
    return gate.promise.finally(() => {
      this.active--;
      this.completed.push(path);
      this.notify();
    });
  };

  release(path: string): void {
    const gate = this.gates.get(path);
    if (!gate) throw new Error(`expected a started neutral path | received: ${path}`);
    gate.resolve(`neutral text ${path}`);
  }

  reject(path: string, reason: unknown): void {
    const gate = this.gates.get(path);
    if (!gate) throw new Error(`expected a started neutral path | received: ${path}`);
    gate.reject(reason);
  }

  releaseAll(): void {
    this.released = true;
    for (const [path, gate] of this.gates) gate.resolve(`neutral text ${path}`);
  }

  async waitForStarted(count: number): Promise<void> {
    await this.waitFor(() => this.started.length >= count);
  }

  async waitForCompleted(count: number): Promise<void> {
    await this.waitFor(() => this.completed.length >= count);
  }

  private async waitFor(ready: () => boolean): Promise<void> {
    if (ready()) return;
    const event = Promise.withResolvers<void>();
    const listener = () => {
      if (!ready()) return;
      this.waiting.delete(listener);
      event.resolve();
    };
    this.waiting.add(listener);
    await event.promise;
  }

  private notify(): void {
    for (const listener of this.waiting) listener();
  }
}

describe('source file batches', () => {
  it('overlaps eight reads and retains every ordered text despite reverse completion', async () => {
    const paths = Array.from({ length: 19 }, (_, index) => `segment-${index}.ts`);
    const reader = new HeldFileReader(paths);
    const operation = readSourceFileBatches(paths, reader.read);
    try {
      expect(reader.started).toEqual(paths.slice(0, 8));
      expect(reader.active).toBe(8);
      for (const path of paths.slice(0, 8).reverse()) reader.release(path);
      await reader.waitForStarted(16);
      expect(reader.started).toEqual(paths.slice(0, 16));
      expect(reader.active).toBe(8);
      for (const path of paths.slice(8, 16).reverse()) reader.release(path);
      await reader.waitForStarted(19);
      for (const path of paths.slice(16).reverse()) reader.release(path);
      expect(await operation).toEqual(paths.map((path) => `neutral text ${path}`));
      expect(reader.peak).toBe(8);
      expect(reader.active).toBe(0);
      expect(reader.completed).toEqual([
        ...paths.slice(0, 8).reverse(),
        ...paths.slice(8, 16).reverse(),
        ...paths.slice(16).reverse(),
      ]);
    } finally {
      reader.releaseAll();
      await operation;
    }
  });

  it('returns an empty inventory without asking the reader for anything', async () => {
    const reader = new HeldFileReader([]);
    expect(await readSourceFileBatches([], reader.read)).toEqual([]);
    expect(reader.started).toEqual([]);
    expect(reader.peak).toBe(0);
  });

  it('drains a failed batch before rejecting and never starts the next batch', async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `neutral-${index}.ts`);
    const reader = new HeldFileReader(paths);
    let settled = false;
    const operation = readSourceFileBatches(paths, reader.read).then(
      (value) => ({ kind: 'fulfilled' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    void operation.then(() => {
      settled = true;
    });
    const first = new Error('first read denied');
    const second = new Error('second read denied');
    try {
      reader.reject(paths[0], first);
      for (const path of paths.slice(2, 8)) reader.release(path);
      await reader.waitForCompleted(7);
      expect(settled).toBe(false);
      expect(reader.started).toEqual(paths.slice(0, 8));
      expect(reader.active).toBe(1);
      reader.reject(paths[1], second);
      const result = await operation;
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') throw new Error('expected failed neutral reads');
      expect(result.error).toBeInstanceOf(AggregateError);
      const failure = result.error as AggregateError;
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0].message).toContain(`API source file "${paths[0]}"`);
      expect(failure.errors[0].cause).toBe(first);
      expect(failure.errors[1].message).toContain(`API source file "${paths[1]}"`);
      expect(failure.errors[1].cause).toBe(second);
      expect(failure.message).toContain(paths[0]);
      expect(failure.message).toContain(paths[1]);
      expect(reader.started).toEqual(paths.slice(0, 8));
      expect(reader.active).toBe(0);
    } finally {
      reader.releaseAll();
      await operation;
    }
  });

  it('also drains sibling reads when a reader throws before returning a promise', async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `sample-${index}.ts`);
    const reader = new HeldFileReader(paths);
    const cause = new Error('synchronous read refusal');
    reader.thrown.set(paths[0], cause);
    const operation = readSourceFileBatches(paths, reader.read).then(
      (value) => ({ kind: 'fulfilled' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    );
    try {
      expect(reader.started).toEqual(paths.slice(0, 8));
      for (const path of paths.slice(1, 8)) reader.release(path);
      const result = await operation;
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') throw new Error('expected a synchronous neutral refusal');
      expect(result.error).toBeInstanceOf(AggregateError);
      const failure = result.error as AggregateError;
      expect(failure.errors).toHaveLength(1);
      expect(failure.errors[0].cause).toBe(cause);
      expect(failure.errors[0].message).toContain(paths[0]);
      expect(reader.completed).toEqual(paths.slice(1, 8));
      expect(reader.started).toEqual(paths.slice(0, 8));
      expect(reader.active).toBe(0);
    } finally {
      reader.releaseAll();
      await operation;
    }
  });
});
