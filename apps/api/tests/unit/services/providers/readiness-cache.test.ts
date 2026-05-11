import { describe, expect, it } from 'bun:test';
import { createReadinessCache } from '../../../../src/services/providers/core/readiness-cache';

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
});
