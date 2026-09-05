import { describe, expect, it } from 'bun:test';
import { bridgeEmitter } from '../../../src/lib/emit-bridge';

async function collect<T>(items: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe('bridgeEmitter', () => {
  it('yields every emitted item in order and exposes the settled result', async () => {
    const bridge = bridgeEmitter<string, number>(async (emit) => {
      emit('a');
      emit('b');
      await Promise.resolve();
      emit('c');
      return 42;
    });

    expect(await collect(bridge.items)).toEqual(['a', 'b', 'c']);
    expect(bridge.result()).toBe(42);
  });

  it('reports no result until the producer has settled', () => {
    const bridge = bridgeEmitter<string, number>(() => new Promise(() => undefined));

    expect(bridge.result()).toBeUndefined();
  });

  it('does not drop items emitted before the generator is first pulled', async () => {
    // The producer starts as soon as bridgeEmitter is called, not on first
    // pull — proves an eager emit still reaches the consumer.
    const bridge = bridgeEmitter<string, void>((emit) => {
      emit('early');
      return Promise.resolve();
    });
    await Promise.resolve();

    expect(await collect(bridge.items)).toEqual(['early']);
  });

  it('surfaces a rejection from the producer to the consumer', async () => {
    const bridge = bridgeEmitter<string, void>(() => Promise.reject(new Error('producer failed')));

    await expect(collect(bridge.items)).rejects.toThrow('producer failed');
  });

  it('resolves `settled` with the producer result even if nothing ever drains `items`', async () => {
    // A consumer that stops pulling early (an SSE client disconnecting, for
    // instance) still needs a way to learn the producer's outcome. `settled`
    // is that path — independent of `items`/`result()`.
    const bridge = bridgeEmitter<string, number>(async (emit) => {
      emit('a');
      await Promise.resolve();
      return 7;
    });

    await expect(bridge.settled).resolves.toBe(7);
  });

  it('rejects `settled` when the producer rejects, without anyone draining `items`', async () => {
    const bridge = bridgeEmitter<string, void>(() => Promise.reject(new Error('producer failed')));

    await expect(bridge.settled).rejects.toThrow('producer failed');
  });

  it('does not leave an unhandled rejection when nobody observes a rejecting producer', async () => {
    // `run-script.ts` keeps only `items` and drops `settled`; a consumer that
    // abandons the generator (an `emit` that throws mid-relay) never reaches
    // `await running` either. Under Bun an unobserved rejection takes the hub
    // process down, so the bridge has to mark its own promise observed.
    const seen: unknown[] = [];
    const onUnhandled = (error: unknown) => seen.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      let reject: ((error: Error) => void) | undefined;
      const bridge = bridgeEmitter<string, void>((emit) => {
        emit('first');
        return new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        });
      });

      const iterator = bridge.items[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toBe('first');
      await iterator.return?.(undefined);

      reject?.(new Error('producer failed'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('interleaves emissions from two concurrent producers merged into one bridge', async () => {
    const bridge = bridgeEmitter<string, void>((emit) =>
      Promise.all([
        (async () => {
          emit('x1');
          await Promise.resolve();
          emit('x2');
        })(),
        (async () => {
          await Promise.resolve();
          emit('y1');
        })(),
      ]).then(() => undefined)
    );

    const items = await collect(bridge.items);
    expect(items.sort()).toEqual(['x1', 'x2', 'y1']);
  });

  it('keeps delivering `settled` after the consumer returns the generator mid-run', async () => {
    // `items()` wraps its loop in a try/finally to stop queueing for a
    // consumer that has gone away; the producer must still run to its own end
    // and hand its result to `settled` — that is the whole reason the upgrade
    // route can still schedule a restart after an SSE client disconnects.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let emitAfterClose: ((line: string) => void) | undefined;

    const bridge = bridgeEmitter<string, number>(async (emit) => {
      emit('first');
      emitAfterClose = emit;
      await held;
      emit('after-return');
      return 9;
    });

    const iterator = bridge.items[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('first');
    // An SSE client disconnecting: sseResponse's cancel() returns the iterator.
    await iterator.return?.(undefined);

    release?.();
    await expect(bridge.settled).resolves.toBe(9);

    // A late emit must not throw into the producer either.
    expect(() => emitAfterClose?.('later')).not.toThrow();
    expect((await iterator.next()).done).toBe(true);
  });
});
