import { describe, expect, it } from 'bun:test';
import { createReadinessCache } from '../../../../src/services/providers/core/readiness-cache';

function expectCount(label: string, expected: number, received: number): void {
  if (expected === received) return;
  throw new Error(`expected ${label}: ${expected} | received: ${received}`);
}

describe('createReadinessCache', () => {
  it('deduplicates concurrent loads for the same key', async () => {
    let calls = 0;
    const cache = createReadinessCache<string>();

    const loader = async () => {
      calls += 1;
      await Promise.resolve();
      return 'ready';
    };

    const [first, second] = await Promise.all([
      cache.get('user-1\u0000model-a', loader),
      cache.get('user-1\u0000model-a', loader),
    ]);

    expect(first).toBe('ready');
    expect(second).toBe('ready');
    expect(calls).toBe(1);
  });

  it('expires cached values after the ttl window', async () => {
    let calls = 0;
    let now = 0;
    const cache = createReadinessCache<string>({ ttlMs: 10, now: () => now });

    const load = () => {
      calls += 1;
      return Promise.resolve(`value-${calls}`);
    };

    const first = await cache.get('user-1\u0000model-a', load);
    now = 5;
    const second = await cache.get('user-1\u0000model-a', load);
    now = 11;
    const third = await cache.get('user-1\u0000model-a', load);

    expect(first).toBe('value-1');
    expect(second).toBe('value-1');
    expect(third).toBe('value-2');
    expect(calls).toBe(2);
  });

  it('clears matching cached and inflight entries', async () => {
    let calls = 0;
    const cache = createReadinessCache<string>();

    const load = () => {
      calls += 1;
      return Promise.resolve(`value-${calls}`);
    };

    await cache.get('user-1\u0000model-a', load);
    await cache.get('user-2\u0000model-a', load);

    cache.clearWhere((key) => key.startsWith('user-1\u0000'));

    const refreshed = await cache.get('user-1\u0000model-a', load);
    const untouched = await cache.get('user-2\u0000model-a', load);

    expect(refreshed).toBe('value-3');
    expect(untouched).toBe('value-2');
  });

  /**
   * `clearWhere` can only remove the in-flight bookkeeping — the load it was
   * tracking is already running and has no cancellation. If a write clears
   * the cache while a read for the same key is still in flight, that read's
   * own `.then()` must not resurrect the pre-write answer once it resolves.
   */
  it('does not let a load already in flight when cleared repopulate the cache', async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const cache = createReadinessCache<string>();

    const load = () => {
      calls += 1;
      const value = `value-${calls}`;
      // Only the first load needs to hang: it is the one already in flight
      // when clearWhere runs below, and it must still be pending there.
      if (calls === 1) {
        return new Promise<string>((resolve) => {
          releaseFirst = () => resolve(value);
        });
      }
      return Promise.resolve(value);
    };

    const stalePromise = cache.get('user-1 model-a', load);
    // The write settles before the stale read's own loader has resolved.
    cache.clearWhere((key) => key.startsWith('user-1 '));
    releaseFirst?.();
    await stalePromise;

    const refreshed = await cache.get('user-1 model-a', load);

    expect(refreshed).toBe('value-2');
  });

  it('lets a third caller join the replacement load when the cleared load settles', async () => {
    const cache = createReadinessCache<string>();
    const releases: Array<(value: string) => void> = [];
    let thirdLoaderCalls = 0;

    const heldLoader = () =>
      new Promise<string>((resolve) => {
        releases.push(resolve);
      });
    const thirdLoader = () => {
      thirdLoaderCalls += 1;
      return Promise.resolve('third');
    };

    const first = cache.get('user-1 model-a', heldLoader);
    cache.clearWhere((key) => key.startsWith('user-1 '));
    const second = cache.get('user-1 model-a', heldLoader);

    releases[0]?.('first');
    expect(await first).toBe('first');

    const third = cache.get('user-1 model-a', thirdLoader);
    expectCount('third-loader calls', 0, thirdLoaderCalls);

    releases[1]?.('second');
    expect(await second).toBe('second');
    expect(await third).toBe('second');
  });

  it('does not let a cleared load write after its replacement already settled', async () => {
    const cache = createReadinessCache<string>();
    const releases: Array<(value: string) => void> = [];
    const heldLoader = () =>
      new Promise<string>((resolve) => {
        releases.push(resolve);
      });

    const cleared = cache.get('user-1 model-a', heldLoader);
    cache.clearWhere((key) => key.startsWith('user-1 '));
    const replacement = cache.get('user-1 model-a', heldLoader);

    releases[1]?.('new');
    expect(await replacement).toBe('new');
    releases[0]?.('old');
    expect(await cleared).toBe('old');

    let laterLoaderCalls = 0;
    const later = await cache.get('user-1 model-a', () => {
      laterLoaderCalls += 1;
      return Promise.resolve('later');
    });
    expect(later).toBe('new');
    expectCount('later-loader calls', 0, laterLoaderCalls);
  });

  it('reports hits and misses through optional callbacks', async () => {
    const events: string[] = [];
    const cache = createReadinessCache<string>({
      onHit: (key) => events.push(`hit:${key}`),
      onMiss: (key) => events.push(`miss:${key}`),
    });

    const load = () => Promise.resolve('ready');

    await cache.get('user-1\u0000model-a', load);
    await cache.get('user-1\u0000model-a', load);

    expect(events).toEqual(['miss:user-1\u0000model-a', 'hit:user-1\u0000model-a']);
  });
});
