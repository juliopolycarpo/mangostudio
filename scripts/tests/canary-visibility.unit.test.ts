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
  const window = new CanaryVisibilityWindow({ retryDelaysMs: [], sleep: clock.sleep.bind(clock) });
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
