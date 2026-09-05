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
});
