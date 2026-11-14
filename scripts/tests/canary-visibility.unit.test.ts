import { expect, test } from 'bun:test';

import { CanaryVisibilityWindow } from '../lib/canary-visibility';

class FakeVisibilityClock {
  readonly delays: number[] = [];
  failure?: Error;
  sleep(delay: number): Promise<void> {
    this.delays.push(delay);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve();
  }
}
class FakeVisibilityReader {
  calls = 0;
  failure?: Error;
  constructor(private readonly values: boolean[]) {}
  read(): Promise<boolean> {
    this.calls++;
    if (this.failure) return Promise.reject(this.failure);
    const next = this.values.length > 1 ? this.values.shift() : this.values[0];
    return Promise.resolve(next ?? false);
  }
}
function confirmed(value: boolean): boolean {
  return value;
}

test('visible reads do not spend delays or repeat I/O', async () => {
  const clock = new FakeVisibilityClock();
  const reader = new FakeVisibilityReader([true]);
  const window = new CanaryVisibilityWindow({ sleep: clock.sleep.bind(clock) });
  expect(await window.read(reader.read.bind(reader), confirmed)).toBe(true);
  expect(reader.calls).toBe(1);
  expect(clock.delays).toEqual([]);
});
test('one shared delay budget bounds multiple post-write reads', async () => {
  const clock = new FakeVisibilityClock();
  const first = new FakeVisibilityReader([false, true]);
  const second = new FakeVisibilityReader([false]);
  const window = new CanaryVisibilityWindow({
    retryDelaysMs: [1, 2],
    sleep: clock.sleep.bind(clock),
  });
  expect(await window.read(first.read.bind(first), confirmed)).toBe(true);
  expect(await window.read(second.read.bind(second), confirmed)).toBe(false);
  expect(clock.delays).toEqual([1, 1, 1]);
  expect(first.calls).toBe(2);
  expect(second.calls).toBe(3);
  const exhausted = new FakeVisibilityReader([false]);
  expect(await window.read(exhausted.read.bind(exhausted), confirmed)).toBe(false);
  expect(exhausted.calls).toBe(1);
  expect(clock.delays).toEqual([1, 1, 1]);
});
test('default retry delays total 60 seconds and return absence on exhaustion', async () => {
  const clock = new FakeVisibilityClock();
  const reader = new FakeVisibilityReader([false]);
  const window = new CanaryVisibilityWindow({ sleep: clock.sleep.bind(clock) });
  expect(await window.read(reader.read.bind(reader), confirmed)).toBe(false);
  expect(clock.delays).toEqual([1000, 2000, 4000, 8000, 15000, 30000]);
  expect(clock.delays.reduce((total, value) => total + value, 0)).toBe(60_000);
  expect(reader.calls).toBe(7);
});
test('empty delays preserve an immediate absent observation', async () => {
  const clock = new FakeVisibilityClock();
  const reader = new FakeVisibilityReader([false]);
  const window = new CanaryVisibilityWindow({
    retryDelaysMs: [],
    sleep: clock.sleep.bind(clock),
  });
  expect(await window.read(reader.read.bind(reader), confirmed)).toBe(false);
  expect(clock.delays).toEqual([]);
  expect(reader.calls).toBe(1);
});
test('transport errors propagate without spending delays', async () => {
  const clock = new FakeVisibilityClock();
  const reader = new FakeVisibilityReader([false]);
  reader.failure = new Error('named transport failure');
  const window = new CanaryVisibilityWindow({ sleep: clock.sleep.bind(clock) });
  await expect(window.read(reader.read.bind(reader), confirmed)).rejects.toThrow(
    'named transport failure'
  );
  expect(clock.delays).toEqual([]);
  expect(reader.calls).toBe(1);
});
test('a failed wait stops before another read', async () => {
  const clock = new FakeVisibilityClock();
  clock.failure = new Error('named wait failure');
  const reader = new FakeVisibilityReader([false]);
  const window = new CanaryVisibilityWindow({ sleep: clock.sleep.bind(clock) });
  await expect(window.read(reader.read.bind(reader), confirmed)).rejects.toThrow(
    'named wait failure'
  );
  expect(reader.calls).toBe(1);
});
test.each(
  [[Infinity], [NaN], [-1], [60_001], Array.from({ length: 17 }, () => 0)].map((retryDelaysMs) => ({
    retryDelaysMs,
  }))
)('refuses an unbounded or invalid delay schedule %j', ({ retryDelaysMs }) => {
  expect(() => new CanaryVisibilityWindow({ retryDelaysMs })).toThrow(
    'expected at most 16 finite nonnegative'
  );
});
test('copies the validated schedule before a caller changes its array', async () => {
  const clock = new FakeVisibilityClock();
  const reader = new FakeVisibilityReader([false, true]);
  const delays = [1];
  const window = new CanaryVisibilityWindow({
    retryDelaysMs: delays,
    sleep: clock.sleep.bind(clock),
  });
  delays[0] = Infinity;
  expect(await window.read(reader.read.bind(reader), confirmed)).toBe(true);
  expect(clock.delays).toEqual([1]);
});

test('independent delayed writes restart backoff within the shared total wait budget', async () => {
  const clock = new FakeVisibilityClock();
  const window = new CanaryVisibilityWindow({ sleep: clock.sleep.bind(clock) });
  const confirmations: boolean[] = [];
  for (let index = 0; index < 15; index++) {
    const write = new FakeVisibilityReader([false, true]);
    confirmations.push(await window.read(write.read.bind(write), confirmed));
  }
  expect(
    confirmations,
    'expected every independent write confirmed within 15s of a 60s delay budget'
  ).toEqual(Array.from({ length: 15 }, () => true));
  expect(clock.delays).toEqual(Array.from({ length: 15 }, () => 1000));
});

test('wall-clock TTL includes time spent inside a successful registry read', async () => {
  let now = 0;
  const window = new CanaryVisibilityWindow({ ttlMs: 50, now: () => now });
  await expect(
    window.read(
      () => {
        now += 51;
        return Promise.resolve(true);
      },
      confirmed,
      'slow registry metadata'
    )
  ).rejects.toThrow('TTL expired');
});

test('one wall-clock deadline is shared across independent reads', async () => {
  let now = 0;
  const window = new CanaryVisibilityWindow({ ttlMs: 50, now: () => now });
  expect(
    await window.read(() => {
      now += 30;
      return Promise.resolve(true);
    }, confirmed)
  ).toBe(true);
  await expect(
    window.read(() => {
      now += 21;
      return Promise.resolve(true);
    }, confirmed)
  ).rejects.toThrow('TTL expired');
});

test.each([0, -1, NaN, Infinity, 2_400_001])('rejects invalid TTL %s', (ttlMs) => {
  expect(() => new CanaryVisibilityWindow({ ttlMs })).toThrow('Invalid canary visibility TTL');
});

test('clamps a wait to the remaining wall-clock TTL and stops before the next read', async () => {
  let now = 0;
  const delays: number[] = [];
  const reader = new FakeVisibilityReader([false, true]);
  const logs: string[] = [];
  const window = new CanaryVisibilityWindow({
    ttlMs: 10,
    retryDelaysMs: [20],
    now: () => now,
    sleep: (delay) => {
      delays.push(delay);
      now += delay;
      return Promise.resolve();
    },
    log: (message) => logs.push(message),
  });
  await expect(window.read(reader.read.bind(reader), confirmed, 'bounded package')).rejects.toThrow(
    'TTL expired'
  );
  expect(delays).toEqual([10]);
  expect(reader.calls).toBe(1);
  expect(logs.join('\n')).toContain('remaining=10ms');
  expect(logs.join('\n')).toContain('TTL expired');
  expect(logs.join('\n')).toContain('bounded package');
});

class StalledVisibilityReader {
  signal?: AbortSignal;
  calls = 0;
  read(signal: AbortSignal): Promise<boolean> {
    this.signal = signal;
    this.calls++;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    );
  }
}

test('aborts stalled I/O at the real deadline and never starts another read after expiry', async () => {
  const reader = new StalledVisibilityReader();
  const window = new CanaryVisibilityWindow({ ttlMs: 25, retryDelaysMs: [] });
  const started = performance.now();
  const result = await Promise.race([
    window.read(reader.read.bind(reader), confirmed, 'stalled metadata').then(
      () => 'unexpected success',
      (cause: Error) => cause.message
    ),
    Bun.sleep(500).then(() => 'watchdog: visibility did not settle'),
  ]);
  expect(result).toContain('TTL expired');
  expect(result).toContain('stalled metadata');
  expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  expect(reader.signal?.aborted).toBe(true);
  await expect(window.read(reader.read.bind(reader), confirmed)).rejects.toThrow('TTL expired');
  expect(reader.calls).toBe(1);
});

test('a twenty-minute TTL accepts a twenty-five step schedule that sums to the TTL', () => {
  const retryDelaysMs = [
    1000,
    2000,
    4000,
    8000,
    15000,
    30000,
    ...Array.from({ length: 19 }, () => 60000),
  ];
  expect(retryDelaysMs).toHaveLength(25);
  expect(
    () => new CanaryVisibilityWindow({ ttlMs: 1_200_000, retryDelaysMs }),
    'expected TTL 1200000 with 25 delays totaling 1200000 to be accepted'
  ).not.toThrow();
});

test('a forty-minute TTL accepts the forty-step default schedule that ends five minutes early', () => {
  const retryDelaysMs = [
    1000,
    2000,
    4000,
    8000,
    15000,
    30000,
    ...Array.from({ length: 34 }, () => 60000),
  ];
  expect(retryDelaysMs).toHaveLength(40);
  expect(retryDelaysMs.reduce((total, delay) => total + delay, 0)).toBe(2_100_000);
  expect(
    () => new CanaryVisibilityWindow({ ttlMs: 2_400_000, retryDelaysMs }),
    'expected TTL 2400000 with 40 delays totaling 2100000 to be accepted'
  ).not.toThrow();
});

test('a TTL schedule longer than forty-eight delays is refused', () => {
  expect(
    () =>
      new CanaryVisibilityWindow({
        ttlMs: 1_200_000,
        retryDelaysMs: Array.from({ length: 49 }, () => 0),
      })
  ).toThrow('expected at most 48 finite nonnegative');
});
