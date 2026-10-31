import { describe, expect, it } from 'bun:test';

import {
  type ProcessResourceMonitorHost,
  startProcessResourceMonitor,
} from '../lib/process-resource-monitor';
import type { ProcessResourceRow } from '../lib/process-resource-sample';

const ROOT: ProcessResourceRow = {
  pid: 42,
  parentPid: 1,
  group: 42,
  command: 'runtime',
  startTicks: 123,
  userTicks: 2,
  systemTicks: 1,
  rssBytes: 1000,
};

class FakeSamplingHost implements ProcessResourceMonitorHost {
  private atMs = 0;
  private timer: (() => void) | undefined;
  canceled = false;
  calls = 0;
  blocked: Promise<readonly ProcessResourceRow[]> | undefined;

  constructor(private readonly frames: Array<readonly ProcessResourceRow[] | Error>) {}

  now = (): number => this.atMs;

  snapshot = (): Promise<readonly ProcessResourceRow[]> => {
    this.calls += 1;
    this.atMs += 10;
    if (this.blocked) return this.blocked;
    const frame = this.frames.shift() ?? [];
    return frame instanceof Error ? Promise.reject(frame) : Promise.resolve(frame);
  };

  repeat = (callback: () => void): (() => void) => {
    this.timer = callback;
    return () => {
      this.canceled = true;
      this.timer = undefined;
    };
  };

  tick(): void {
    this.timer?.();
  }
}

const OPTIONS = { pageBytes: 4096, ticksPerSecond: 100 };

describe('process resource monitor', () => {
  it('excludes a census that finishes after the actual readiness timestamp', async () => {
    const host = new FakeSamplingHost([[ROOT], [{ ...ROOT, userTicks: 99, rssBytes: 9999 }], []]);
    const monitor = await startProcessResourceMonitor(42, { ...OPTIONS, host });
    await monitor.markReady(5);
    const result = await monitor.stop();
    expect(result.readinessAtMs).toBe(5);
    expect(result.summary).toMatchObject({
      sampleCount: 0,
      peakSampledRssBytes: null,
      sampledUserCpuMs: null,
      sampledSystemCpuMs: null,
      remainingIdentities: [],
    });
    expect(result.frames.length).toBeGreaterThan(0);
  });
  it('rejects a timestamp from a future or invalid clock', async () => {
    const host = new FakeSamplingHost([[ROOT], []]);
    const monitor = await startProcessResourceMonitor(42, { ...OPTIONS, host });
    await expect(monitor.markReady(Number.NaN)).rejects.toThrow('expected finite monotonic time');
    await expect(monitor.markReady(100)).rejects.toThrow('expected finite monotonic time');
    await monitor.stop();
  });

  it('freezes readiness resources and captures cleanup separately', async () => {
    const host = new FakeSamplingHost([[ROOT], [{ ...ROOT, userTicks: 5, rssBytes: 2000 }], []]);
    const monitor = await startProcessResourceMonitor(42, { ...OPTIONS, host });
    await monitor.markReady();
    const result = await monitor.stop();
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      peakSampledRssBytes: 1000,
      sampledUserCpuMs: 20,
      remainingIdentities: [],
    });
    expect(host.canceled).toBe(true);
    expect(monitor.stop()).toBe(monitor.stop());
    await expect(monitor.markReady()).rejects.toThrow(
      'expected running sampler | received: stopped'
    );
  });

  it('retains a failed census even when a later cleanup census succeeds', async () => {
    const host = new FakeSamplingHost([[ROOT], new Error('procfs EIO'), []]);
    const monitor = await startProcessResourceMonitor(42, { ...OPTIONS, host });
    await monitor.markReady();
    const result = await monitor.stop();
    expect(result.errors).toEqual(['procfs EIO']);
    expect(result.summary?.remainingIdentities).toEqual([]);
    expect(result.frames).toHaveLength(2);
  });

  it('does not overlap or accumulate periodic reads while a census is stalled', async () => {
    const host = new FakeSamplingHost([[ROOT]]);
    const monitor = await startProcessResourceMonitor(42, { ...OPTIONS, host });
    const stalled = Promise.withResolvers<readonly ProcessResourceRow[]>();
    host.blocked = stalled.promise;
    host.tick();
    host.tick();
    host.tick();
    await Promise.resolve();
    expect(host.calls).toBe(2);
    const ready = monitor.markReady();
    host.blocked = undefined;
    stalled.resolve([ROOT]);
    await ready;
    await monitor.stop();
    expect(host.calls).toBe(3);
  });

  it('retains raw frames when their summary is invalid', async () => {
    const host = new FakeSamplingHost([[ROOT], []]);
    const monitor = await startProcessResourceMonitor(42, { ...OPTIONS, ticksPerSecond: 0, host });
    const result = await monitor.stop();
    expect(result.summary).toBeNull();
    expect(result.errors[0]).toContain('ticksPerSecond: expected a positive safe integer');
    expect(result.frames).toHaveLength(2);
  });

  it('refuses an absent initial process without starting a timer', async () => {
    const host = new FakeSamplingHost([[]]);
    await expect(startProcessResourceMonitor(42, { ...OPTIONS, host })).rejects.toThrow(
      'resource root: expected live pid 42 | received: absent'
    );
    host.tick();
    expect(host.calls).toBe(1);
  });

  it.each([0, -1, Number.NaN])('rejects invalid interval %s', async (intervalMs) => {
    const host = new FakeSamplingHost([[ROOT]]);
    await expect(startProcessResourceMonitor(42, { ...OPTIONS, intervalMs, host })).rejects.toThrow(
      'expected positive finite milliseconds'
    );
    expect(host.calls).toBe(0);
  });
});
