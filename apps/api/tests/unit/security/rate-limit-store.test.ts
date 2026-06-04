import { describe, expect, it } from 'bun:test';
import { RateLimitStore } from '../../../src/plugins/rate-limit-store';

const WINDOW = 60_000;

describe('RateLimitStore.touch', () => {
  it('starts a fresh counter at 1 with a window-end resetTime', () => {
    const store = new RateLimitStore(100);

    const entry = store.touch('k', WINDOW, 1_000);

    expect(entry.count).toBe(1);
    expect(entry.resetTime).toBe(1_000 + WINDOW);
    expect(store.size).toBe(1);
  });

  it('increments an existing counter within the same window', () => {
    const store = new RateLimitStore(100);

    store.touch('k', WINDOW, 1_000);
    const entry = store.touch('k', WINDOW, 1_500);

    expect(entry.count).toBe(2);
    expect(entry.resetTime).toBe(1_000 + WINDOW); // unchanged until reset
    expect(store.size).toBe(1);
  });

  it('resets the counter once the window has elapsed', () => {
    const store = new RateLimitStore(100);

    store.touch('k', WINDOW, 1_000);
    const entry = store.touch('k', WINDOW, 1_000 + WINDOW + 1);

    expect(entry.count).toBe(1);
    expect(entry.resetTime).toBe(1_000 + WINDOW + 1 + WINDOW);
  });
});

describe('RateLimitStore.removeExpired', () => {
  it('drops entries whose window elapsed and keeps live ones', () => {
    const store = new RateLimitStore(100);
    store.touch('expired', WINDOW, 1_000);
    store.touch('live', WINDOW, 1_000 + WINDOW);

    store.removeExpired(1_000 + WINDOW + 1);

    // 'expired' resetTime (61_000) < now (61_001) → removed; 'live' survives.
    expect(store.size).toBe(1);
  });
});

describe('RateLimitStore.evictOverflow', () => {
  it('no-ops while at or below maxSize', () => {
    const store = new RateLimitStore(3);
    store.touch('a', WINDOW, 1_000);
    store.touch('b', WINDOW, 1_000);
    store.touch('c', WINDOW, 1_000);

    store.evictOverflow();

    expect(store.size).toBe(3);
  });

  it('evicts the oldest entries down to maxSize', () => {
    const store = new RateLimitStore(2);
    store.touch('oldest', WINDOW, 1_000);
    store.touch('middle', WINDOW, 1_000);
    store.touch('newest', WINDOW, 1_000);

    store.evictOverflow();

    expect(store.size).toBe(2);
    // Oldest insertion is evicted first; re-touching it starts a fresh counter.
    expect(store.touch('oldest', WINDOW, 1_000).count).toBe(1);
    // The newest entry was retained, so touching it again continues its counter.
    expect(store.touch('newest', WINDOW, 1_000).count).toBe(2);
  });
});

describe('RateLimitStore.clear', () => {
  it('drops every entry', () => {
    const store = new RateLimitStore(100);
    store.touch('a', WINDOW, 1_000);
    store.touch('b', WINDOW, 1_000);

    store.clear();

    expect(store.size).toBe(0);
  });
});
