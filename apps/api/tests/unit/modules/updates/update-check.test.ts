/**
 * The release checker: skip rules, TTL/error-TTL caching, single in-flight
 * fetch, and the stable/canary channel logic. No test here touches the real
 * network, disk, clock, or timers — `fetch`, the cache store, `now`, and the
 * timer functions are all injected.
 */

import { describe, expect, it } from 'bun:test';
import type { UpdateChannel, UpdateCheck } from '@mangostudio/shared/updates';
import type { MangoConfig } from '../../../../src/lib/config';
import {
  createUpdateChecker,
  parseUpdateCheckFile,
  type UpdateCheckerDeps,
  updateChecker,
  updateCheckSkipReason,
} from '../../../../src/modules/updates/application/update-check';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 as const };
const publicResolver = () => Promise.resolve([PUBLIC_ADDRESS]);

/** Stands in for the `update-check.json` file: an in-memory slot, nothing on disk. */
class FakeUpdateCheckStore {
  private value: UpdateCheck | null = null;

  read = (): UpdateCheck | null => this.value;

  write = (_path: string, check: UpdateCheck): Promise<void> => {
    this.value = check;
    return Promise.resolve();
  };

  set(check: UpdateCheck | null): void {
    this.value = check;
  }
}

/** Named fake fetch keyed by exact URL, so a call to an unmapped URL fails loudly. */
class FakeFetch {
  readonly calls: string[] = [];

  constructor(private readonly responses: Record<string, () => Response>) {}

  readonly fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    this.calls.push(url);
    const make = this.responses[url];
    if (!make) return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    return Promise.resolve(make());
  }) as unknown as typeof fetch;
}

/** Timer functions the checker calls only through `schedule()`; fired by hand. */
class FakeTimers {
  private nextId = 1;
  private readonly timeouts = new Map<number, () => void>();
  private readonly intervals = new Map<number, () => void>();

  setTimeout = ((fn: () => void) => {
    const id = this.nextId++;
    this.timeouts.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  clearTimeout = ((id: unknown) => {
    this.timeouts.delete(id as number);
  }) as unknown as typeof clearTimeout;

  setInterval = ((fn: () => void) => {
    const id = this.nextId++;
    this.intervals.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  clearInterval = ((id: unknown) => {
    this.intervals.delete(id as number);
  }) as unknown as typeof clearInterval;

  fireTimeouts(): void {
    for (const fn of [...this.timeouts.values()]) fn();
  }

  fireIntervals(): void {
    for (const fn of [...this.intervals.values()]) fn();
  }

  get timeoutCount(): number {
    return this.timeouts.size;
  }

  get intervalCount(): number {
    return this.intervals.size;
  }
}

function configWith(check: boolean, channel: UpdateChannel | null = null): MangoConfig {
  return { updates: { check, channel } } as MangoConfig;
}

const STABLE_TAG_RESPONSE = (tag: string) =>
  new Response(JSON.stringify({ tag_name: tag }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const CANARY_MANIFEST_RESPONSE = (overrides: Partial<Record<string, unknown>> = {}) =>
  new Response(
    JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '0.1.1-canary.deadbee',
      assetVersion: '0.1.1-canary',
      sourceSha: 'deadbeef00',
      builtAt: '2026-09-01T00:00:00Z',
      pairs: [],
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

interface Harness {
  deps: Partial<UpdateCheckerDeps>;
  store: FakeUpdateCheckStore;
  timers: FakeTimers;
  clock: { now: number };
}

function harness(overrides: Partial<UpdateCheckerDeps> = {}): Harness {
  const store = new FakeUpdateCheckStore();
  const timers = new FakeTimers();
  const clock = { now: 0 };
  const deps: Partial<UpdateCheckerDeps> = {
    getConfig: () => configWith(true),
    getCurrentVersion: () => '0.1.1',
    getBuildInfo: () => ({
      gitSha: 'deadbeef00',
      gitDirty: false,
      builtAt: 'x',
      buildType: 'production',
    }),
    env: {},
    resolveHostname: publicResolver,
    cachePath: () => '/fake/run/update-check.json',
    readCacheFile: store.read,
    writeCacheFile: store.write,
    now: () => clock.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...overrides,
  };
  return { deps, store, timers, clock };
}

describe('updateCheckSkipReason', () => {
  it('is disabled when updates.check is off', () => {
    expect(updateCheckSkipReason(configWith(false), {}, '0.1.1')).toBe('disabled');
  });

  it('is env when NO_UPDATE_NOTIFIER, DO_NOT_TRACK or CI is set non-empty', () => {
    expect(updateCheckSkipReason(configWith(true), { NO_UPDATE_NOTIFIER: '1' }, '0.1.1')).toBe(
      'env'
    );
    expect(updateCheckSkipReason(configWith(true), { DO_NOT_TRACK: '1' }, '0.1.1')).toBe('env');
    expect(updateCheckSkipReason(configWith(true), { CI: 'true' }, '0.1.1')).toBe('env');
  });

  it('ignores an env opt-out set to an empty string', () => {
    expect(updateCheckSkipReason(configWith(true), { CI: '' }, '0.1.1')).toBeNull();
  });

  it('is dev for a development build', () => {
    expect(updateCheckSkipReason(configWith(true), {}, 'dev')).toBe('dev');
  });

  it('is null when nothing opts out', () => {
    expect(updateCheckSkipReason(configWith(true), {}, '0.1.1')).toBeNull();
  });
});

describe('createUpdateChecker', () => {
  describe('readCached', () => {
    it('returns null without reading the store when checks are skipped', () => {
      const { deps, store } = harness({ getConfig: () => configWith(false) });
      store.set({
        channel: 'stable',
        currentVersion: '0.1.1',
        updateAvailable: false,
        checkedAt: 0,
      });

      expect(createUpdateChecker(deps).readCached()).toBeNull();
    });

    it('returns whatever the store holds when checks are active', () => {
      const { deps, store } = harness();
      const cached: UpdateCheck = {
        channel: 'stable',
        currentVersion: '0.1.1',
        latestVersion: '0.2.0',
        updateAvailable: true,
        checkedAt: 0,
      };
      store.set(cached);

      expect(createUpdateChecker(deps).readCached()).toEqual(cached);
    });

    it('returns null when the cache is for a channel config no longer names', () => {
      // Same staleness rule `isFresh` applies inside `check()`: a cache
      // written on canary must not answer for a hub just switched to stable
      // (or vice versa), even though nothing has expired it yet.
      const { deps, store } = harness({ getConfig: () => configWith(true, 'stable') });
      store.set({
        channel: 'canary',
        currentVersion: '0.1.1-canary.deadbee',
        latestVersion: '0.1.2-canary.cafebee',
        updateAvailable: true,
        checkedAt: 0,
      });

      expect(createUpdateChecker(deps).readCached()).toBeNull();
    });
  });

  describe('check', () => {
    it('returns null and never fetches when skipped', async () => {
      const fake = new FakeFetch({});
      const { deps } = harness({ getConfig: () => configWith(false), fetch: fake.fetch });

      const result = await createUpdateChecker(deps).check();

      expect(result).toBeNull();
      expect(fake.calls).toEqual([]);
    });

    it('fetches the stable channel and reports an available update', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.2.0'),
      });
      const { deps, store } = harness({ fetch: fake.fetch });

      const result = await createUpdateChecker(deps).check();

      expect(result).toMatchObject({
        channel: 'stable',
        currentVersion: '0.1.1',
        latestVersion: '0.2.0',
        updateAvailable: true,
      });
      expect(store.read()).toEqual(result);
      expect(fake.calls).toHaveLength(1);
    });

    it('reports no update when the stable tag matches the current version', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.1.1'),
      });
      const { deps } = harness({ fetch: fake.fetch });

      const result = await createUpdateChecker(deps).check();

      expect(result?.updateAvailable).toBe(false);
    });

    it('does not offer a yanked release that leaves latest behind the running version', async () => {
      // The tag GitHub reports as "latest" can fall behind after a release
      // is deleted (0.1.5 published, then pulled, leaving 0.1.4 as latest
      // again) — string inequality would still call that an "update".
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.1.4'),
      });
      const { deps } = harness({ fetch: fake.fetch, getCurrentVersion: () => '0.1.5' });

      const result = await createUpdateChecker(deps).check();

      expect(result).toMatchObject({ latestVersion: '0.1.4', updateAvailable: false });
    });

    it('reports an update available once a newer patch is actually published', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.1.10'),
      });
      const { deps } = harness({ fetch: fake.fetch, getCurrentVersion: () => '0.1.9' });

      const result = await createUpdateChecker(deps).check();

      expect(result).toMatchObject({ latestVersion: '0.1.10', updateAvailable: true });
    });

    it('fetches the canary manifest at the rolling tag and compares source shas', async () => {
      const fake = new FakeFetch({
        'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1-canary/canary-manifest.json':
          () => CANARY_MANIFEST_RESPONSE({ sourceSha: 'cafebabe00' }),
      });
      const { deps } = harness({
        fetch: fake.fetch,
        getCurrentVersion: () => '0.1.1-canary.deadbee',
        getConfig: () => configWith(true, 'canary'),
        getBuildInfo: () => ({
          gitSha: 'deadbeef00',
          gitDirty: false,
          builtAt: 'x',
          buildType: 'production',
        }),
      });

      const result = await createUpdateChecker(deps).check();

      expect(result).toMatchObject({
        channel: 'canary',
        latestVersion: '0.1.1-canary.deadbee',
        latestSourceSha: 'cafebabe00',
        updateAvailable: true,
      });
      expect(fake.calls).toHaveLength(1);
    });

    it('reports no canary update when the manifest sha shares this build’s prefix', async () => {
      const fake = new FakeFetch({
        'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1-canary/canary-manifest.json':
          () => CANARY_MANIFEST_RESPONSE({ sourceSha: 'deadbeef0011223344' }),
      });
      const { deps } = harness({
        fetch: fake.fetch,
        getCurrentVersion: () => '0.1.1-canary.deadbee',
        getConfig: () => configWith(true, 'canary'),
        getBuildInfo: () => ({
          gitSha: 'deadbeef00',
          gitDirty: false,
          builtAt: 'x',
          buildType: 'production',
        }),
      });

      const result = await createUpdateChecker(deps).check();

      expect(result?.updateAvailable).toBe(false);
    });

    it('falls back to a version compare when this build has no stamped git sha', async () => {
      // build-info.ts's own fallback for an unstamped build is the literal
      // string 'unknown' — never a real hex sha, so a prefix compare against
      // it would call this permanently out of date even when it is running
      // the exact commit the manifest names.
      const fake = new FakeFetch({
        'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1-canary/canary-manifest.json':
          () => CANARY_MANIFEST_RESPONSE({ sourceSha: 'cafebabe00' }),
      });
      const { deps } = harness({
        fetch: fake.fetch,
        getCurrentVersion: () => '0.1.1-canary.deadbee',
        getConfig: () => configWith(true, 'canary'),
        getBuildInfo: () => ({
          gitSha: 'unknown',
          gitDirty: 'unknown',
          builtAt: 'x',
          buildType: 'production',
        }),
      });

      const result = await createUpdateChecker(deps).check();

      // The manifest's own version matches currentVersion, so the version
      // fallback agrees this build is current.
      expect(result).toMatchObject({
        latestVersion: '0.1.1-canary.deadbee',
        updateAvailable: false,
      });
    });

    it('still reports a canary update via version compare when unstamped and the manifest has moved on', async () => {
      const fake = new FakeFetch({
        'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1-canary/canary-manifest.json':
          () =>
            CANARY_MANIFEST_RESPONSE({ version: '0.1.1-canary.cafebee', sourceSha: 'cafebee000' }),
      });
      const { deps } = harness({
        fetch: fake.fetch,
        getCurrentVersion: () => '0.1.1-canary.deadbee',
        getConfig: () => configWith(true, 'canary'),
        getBuildInfo: () => ({
          gitSha: 'unknown',
          gitDirty: 'unknown',
          builtAt: 'x',
          buildType: 'production',
        }),
      });

      const result = await createUpdateChecker(deps).check();

      expect(result).toMatchObject({
        latestVersion: '0.1.1-canary.cafebee',
        updateAvailable: true,
      });
    });

    it('resolves the rolling tag the same way for a stable build asking about canary', async () => {
      const fake = new FakeFetch({
        'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1-canary/canary-manifest.json':
          () => CANARY_MANIFEST_RESPONSE({ sourceSha: 'cafebabe00' }),
      });
      const { deps } = harness({
        fetch: fake.fetch,
        getCurrentVersion: () => '0.1.1',
        getConfig: () => configWith(true, 'canary'),
      });

      const result = await createUpdateChecker(deps).check();

      // A stable build's own sha never shares a prefix with the canary
      // manifest's, so a manifest that exists always reads as available.
      expect(result?.updateAvailable).toBe(true);
    });

    it('never throws on a network failure and caches the error with a short TTL', async () => {
      const fake = new FakeFetch({});
      const { deps, store, clock } = harness({ fetch: fake.fetch });
      const checker = createUpdateChecker(deps);

      const result = await checker.check();

      expect(result?.error).toBeDefined();
      expect(result?.updateAvailable).toBe(false);
      expect(store.read()).toEqual(result);

      // Not retried before the error TTL elapses.
      clock.now = 30 * 60 * 1000;
      const stillCached = await checker.check();
      expect(fake.calls).toHaveLength(1);
      expect(stillCached).toEqual(result);

      // Retried once the error TTL elapses.
      clock.now = 61 * 60 * 1000;
      await checker.check();
      expect(fake.calls).toHaveLength(2);
    });

    it('reuses a fresh cached answer instead of fetching again', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.2.0'),
      });
      const { deps } = harness({ fetch: fake.fetch });
      const checker = createUpdateChecker(deps);

      await checker.check();
      await checker.check();

      expect(fake.calls).toHaveLength(1);
    });

    it('does not reuse a fresh cache from a different channel', async () => {
      const fake = new FakeFetch({
        'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1-canary/canary-manifest.json':
          () => CANARY_MANIFEST_RESPONSE({ sourceSha: 'cafebabe00' }),
      });
      const store = new FakeUpdateCheckStore();
      store.set({
        channel: 'stable',
        currentVersion: '0.1.1',
        latestVersion: '0.1.1',
        updateAvailable: false,
        checkedAt: 0,
      });
      const { deps } = harness({
        fetch: fake.fetch,
        readCacheFile: store.read,
        writeCacheFile: store.write,
        getConfig: () => configWith(true, 'canary'),
      });

      const result = await createUpdateChecker(deps).check();

      expect(fake.calls).toHaveLength(1);
      expect(result?.channel).toBe('canary');
    });

    it('re-fetches once the 24h TTL elapses', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.2.0'),
      });
      const { deps, clock } = harness({ fetch: fake.fetch });
      const checker = createUpdateChecker(deps);

      await checker.check();
      clock.now = 24 * 60 * 60 * 1000 + 1;
      await checker.check();

      expect(fake.calls).toHaveLength(2);
    });

    it('force re-fetches even when the cache is fresh', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.2.0'),
      });
      const { deps } = harness({ fetch: fake.fetch });
      const checker = createUpdateChecker(deps);

      await checker.check();
      await checker.check({ force: true });

      expect(fake.calls).toHaveLength(2);
    });

    it('makes exactly one network call for concurrent checks', async () => {
      let resolveResponse!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      const calls: string[] = [];
      const fetchOnePendingResponse = ((input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return pending;
      }) as unknown as typeof fetch;
      const { deps } = harness({ fetch: fetchOnePendingResponse });
      const checker = createUpdateChecker(deps);

      const first = checker.check();
      const second = checker.check();
      resolveResponse(STABLE_TAG_RESPONSE('v0.2.0'));
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(calls).toHaveLength(1);
      expect(firstResult).toEqual(secondResult);
    });
  });

  describe('schedule', () => {
    it('checks once after the initial delay, then every interval tick', async () => {
      const fake = new FakeFetch({
        'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest': () =>
          STABLE_TAG_RESPONSE('v0.2.0'),
      });
      const { deps, timers, clock } = harness({ fetch: fake.fetch });
      const checker = createUpdateChecker(deps);

      const stop = checker.schedule();
      expect(timers.timeoutCount).toBe(1);
      expect(timers.intervalCount).toBe(1);

      timers.fireTimeouts();
      // `runOnce` fires `check()` without awaiting it (the timer callback
      // cannot be async), so the test waits out the fetch's own microtask
      // chain (address policy, then the request) on a real timer instead of
      // guessing how many `Promise.resolve()` hops that takes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.calls).toHaveLength(1);

      // The interval tick is a second, independent call: the cache from the
      // first is still fresh, so it only counts once the clock has moved past
      // the 24h TTL.
      clock.now = 24 * 60 * 60 * 1000 + 1;
      timers.fireIntervals();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.calls).toHaveLength(2);

      stop();
    });

    it('stop clears both the initial timeout and the interval', () => {
      const { deps, timers } = harness();
      const checker = createUpdateChecker(deps);

      const stop = checker.schedule();
      stop();

      expect(timers.timeoutCount).toBe(0);
      expect(timers.intervalCount).toBe(0);
    });
  });
});

describe('updateChecker singleton', () => {
  it('is built from the real dependencies', () => {
    expect(typeof updateChecker.readCached).toBe('function');
    expect(typeof updateChecker.check).toBe('function');
    expect(typeof updateChecker.schedule).toBe('function');
  });
});

describe('parseUpdateCheckFile', () => {
  const VALID: UpdateCheck = {
    channel: 'stable',
    currentVersion: '0.1.1',
    latestVersion: '0.1.2',
    updateAvailable: true,
    checkedAt: 1_000,
  };

  it('accepts a well-formed cache file', () => {
    expect(parseUpdateCheckFile(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('rejects invalid JSON', () => {
    expect(parseUpdateCheckFile('not json')).toBeNull();
  });

  it('rejects a latestVersion of the wrong type', () => {
    expect(parseUpdateCheckFile(JSON.stringify({ ...VALID, latestVersion: 42 }))).toBeNull();
  });

  it('rejects a latestSourceSha of the wrong type', () => {
    expect(
      parseUpdateCheckFile(JSON.stringify({ ...VALID, channel: 'canary', latestSourceSha: 42 }))
    ).toBeNull();
  });

  it('rejects a negative checkedAt', () => {
    expect(parseUpdateCheckFile(JSON.stringify({ ...VALID, checkedAt: -1 }))).toBeNull();
  });
});
