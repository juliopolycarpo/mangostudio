import { describe, expect, it } from 'bun:test';

import {
  benchmarkCancellation,
  type BenchmarkSignalHost,
  withBenchmarkCancellation,
} from '../lib/benchmark-cancellation';

class FakeBenchmarkSignals implements BenchmarkSignalHost {
  readonly listeners = new Map<string, Set<() => void>>();
  on(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  off(name: string, listener: () => void): void {
    this.listeners.get(name)?.delete(listener);
  }
  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}
describe('benchmark cancellation', () => {
  it.each(['SIGINT', 'SIGTERM'])(
    'turns %s into cleanup-capable cancellation and removes only its listeners',
    (name) => {
      const host = new FakeBenchmarkSignals();
      let unrelated = 0;
      host.on(name, () => {
        unrelated += 1;
      });
      const cancellation = benchmarkCancellation(host);
      host.emit(name);
      expect(cancellation.signal.aborted).toBe(true);
      expect(String(cancellation.signal.reason)).toContain(`Benchmark canceled by ${name}`);
      cancellation.dispose();
      host.emit(name);
      expect(unrelated).toBe(2);
      expect(host.listeners.get(name)?.size).toBe(1);
    }
  );
  it('preserves task success and failure without cancellation', async () => {
    const controller = new AbortController();
    expect(await withBenchmarkCancellation(Promise.resolve(4), controller.signal)).toBe(4);
    await expect(
      withBenchmarkCancellation(
        Promise.reject(new Error('intended task failure')),
        controller.signal
      )
    ).rejects.toThrow('intended task failure');
  });
  it('cancels an active or already aborted await', async () => {
    const controller = new AbortController();
    const active = withBenchmarkCancellation(
      Promise.withResolvers<never>().promise,
      controller.signal
    );
    controller.abort(new Error('intended cancellation'));
    await expect(active).rejects.toThrow('intended cancellation');
    await expect(withBenchmarkCancellation(Promise.resolve(1), controller.signal)).rejects.toThrow(
      'intended cancellation'
    );
  });
});
