import { describe, expect, it } from 'bun:test';

import {
  parseLinuxProcessResourceStat,
  type ProcessResourceFrame,
  type ProcessResourceRow,
  ProcessResourceTracker,
  summarizeProcessResources,
} from '../lib/process-resource-sample';

/** Synthetic procfs line; fields intentionally include nested command parentheses. */
function procStatLine(overrides: Record<number, string> = {}): string {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[0] = 'S';
  fields[1] = '10';
  fields[2] = '42';
  fields[11] = '12';
  fields[12] = '3';
  fields[19] = '456';
  fields[21] = '20';
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  return `42 (a child (worker) name) ${fields.join(' ')}`;
}

function row(overrides: Partial<ProcessResourceRow> = {}): ProcessResourceRow {
  return {
    pid: 42,
    parentPid: 10,
    group: 42,
    command: 'runtime',
    startTicks: 456,
    userTicks: 2,
    systemTicks: 1,
    rssBytes: 1000,
    ...overrides,
  };
}

const ROOT = { pid: 42, startTicks: 456 };

function summarize(frames: readonly ProcessResourceFrame[], measurementEndMs?: number) {
  return summarizeProcessResources(ROOT, frames, { ticksPerSecond: 100, measurementEndMs });
}

describe('Linux process resource stat parser', () => {
  it('parses explicit clock ticks and page units despite command-name parentheses', () => {
    expect(parseLinuxProcessResourceStat(42, procStatLine(), 4096)).toEqual({
      pid: 42,
      parentPid: 10,
      group: 42,
      command: 'a child (worker) name',
      startTicks: 456,
      userTicks: 12,
      systemTicks: 3,
      rssBytes: 81920,
    });
  });

  it('rejects an incorrect pid and malformed records', () => {
    expect(() => parseLinuxProcessResourceStat(43, procStatLine(), 4096)).toThrow(
      'expected matching pid (comm) fields'
    );
    expect(() => parseLinuxProcessResourceStat(42, 'malformed', 4096)).toThrow(
      'received: "malformed"'
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid page size %s', (pageBytes) => {
    expect(() => parseLinuxProcessResourceStat(42, procStatLine(), pageBytes)).toThrow(
      `pageBytes: expected a positive safe integer | received: ${pageBytes}`
    );
  });

  it.each([
    [1, '-1'],
    [11, 'not-ticks'],
    [12, 'NaN'],
    [19, '1.5'],
    [21, '9007199254740992'],
  ] as const)('rejects malformed numeric field %s=%s', (index, value) => {
    expect(() => parseLinuxProcessResourceStat(42, procStatLine({ [index]: value }), 4096)).toThrow(
      'expected a nonnegative safe integer'
    );
  });
});

describe('owned process resource summary', () => {
  it('leaves all metrics unavailable when readiness preceded observation', () => {
    const summary = summarize(
      [
        { atMs: 0, processes: [row()] },
        { atMs: 1, processes: [] },
      ],
      -1
    );
    expect(summary).toMatchObject({
      sampleCount: 0,
      peakSampledRssBytes: null,
      sampledUserCpuMs: null,
      sampledSystemCpuMs: null,
      remainingIdentities: [],
    });
  });
  it('does not call wrapper-only observations actual-child resource samples', () => {
    const summary = summarizeProcessResources(
      ROOT,
      [
        { atMs: 0, processes: [row()] },
        { atMs: 1, processes: [] },
      ],
      { ticksPerSecond: 100, omitRootFromMetrics: true }
    );
    expect(summary).toMatchObject({
      sampleCount: 0,
      observedProcessCount: 0,
      peakSampledRssBytes: null,
      sampledUserCpuMs: null,
    });
  });

  it('omits a measurement wrapper from metrics while retaining ownership and raw rows', () => {
    const child = row({ pid: 43, parentPid: 42, startTicks: 500, userTicks: 3, rssBytes: 400 });
    const summary = summarizeProcessResources(ROOT, [{ atMs: 0, processes: [row(), child] }], {
      ticksPerSecond: 100,
      omitRootFromMetrics: true,
    });
    expect(summary).toMatchObject({
      peakSampledRssBytes: 400,
      sampledUserCpuMs: 30,
      observedProcessCount: 1,
    });
    expect(summary.frames[0]?.processes).toHaveLength(2);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid measurement endpoint %s',
    (measurementEndMs) => {
      expect(() => summarize([], measurementEndMs)).toThrow(
        'measurementEndMs: expected finite milliseconds relative to observation origin'
      );
    }
  );

  it('retains only owned frames for online collection and protects them from reused mutable rows', () => {
    const tracker = new ProcessResourceTracker(ROOT);
    const mutable = { ...row() };
    tracker.observe({ atMs: 0, processes: [mutable, row({ pid: 99, group: 99 })] });
    mutable.userTicks = 999;
    tracker.observe({ atMs: 10, processes: [] });
    expect(tracker.frames()[0]?.processes).toHaveLength(1);
    expect(tracker.summarize({ ticksPerSecond: 100 })).toMatchObject({
      peakSampledRssBytes: 1000,
      sampledUserCpuMs: 20,
      remainingIdentities: [],
    });
  });

  it('preserves unavailable observations as null', () => {
    const summary = summarize([{ atMs: 0, processes: [row({ pid: 99, group: 99 })] }]);
    expect(summary).toMatchObject({
      sampleCount: 0,
      observedProcessCount: 0,
      peakSampledRssBytes: null,
      sampledUserCpuMs: null,
      sampledSystemCpuMs: null,
    });
  });

  it('separates valid zero observed ticks from unavailable CPU data', () => {
    expect(
      summarize([{ atMs: 0, processes: [row({ userTicks: 0, systemTicks: 0 })] }])
    ).toMatchObject({
      sampledUserCpuMs: 0,
      sampledSystemCpuMs: 0,
      cpuResolutionMs: 10,
    });
  });

  it('sums only contemporaneous descendant RSS and retains exited child CPU', () => {
    const child = row({ pid: 43, parentPid: 42, startTicks: 500, userTicks: 3, rssBytes: 400 });
    const grandchild = row({
      pid: 44,
      parentPid: 43,
      startTicks: 501,
      userTicks: 4,
      rssBytes: 600,
    });
    const summary = summarize([
      {
        atMs: 0,
        processes: [grandchild, child, row(), row({ pid: 99, group: 99, rssBytes: 1_000_000 })],
      },
      { atMs: 10, processes: [row({ userTicks: 5, rssBytes: 1500 })] },
      { atMs: 20, processes: [] },
    ]);
    expect(summary).toMatchObject({
      sampleCount: 2,
      observedProcessCount: 3,
      peakSampledRssBytes: 2000,
      sampledUserCpuMs: 120,
      sampledSystemCpuMs: 30,
      remainingIdentities: [],
    });
    expect(summary.frames[0]?.processes).toHaveLength(3);
  });

  it('keeps an observed child after reparenting and refuses a reused root pid', () => {
    const child = row({ pid: 43, parentPid: 42, startTicks: 500 });
    const summary = summarize([
      { atMs: 0, processes: [row(), child] },
      {
        atMs: 10,
        processes: [
          row({ startTicks: 9999, group: 99, userTicks: 1000 }),
          { ...child, parentPid: 1, userTicks: 4 },
        ],
      },
    ]);
    expect(summary.remainingIdentities).toEqual(['43:500']);
    expect(summary.sampledUserCpuMs).toBe(60);
  });

  it('does not adopt a new child of an unrelated process reusing the root pid', () => {
    const summary = summarize([
      { atMs: 0, processes: [row()] },
      {
        atMs: 10,
        processes: [row({ startTicks: 9999 }), row({ pid: 50, parentPid: 42, startTicks: 900 })],
      },
    ]);
    expect(summary.observedProcessCount).toBe(1);
    expect(summary.remainingIdentities).toEqual([]);
  });

  it('tracks post-readiness cleanup without adding it to startup resource metrics', () => {
    const summary = summarize(
      [
        { atMs: 0, processes: [row()] },
        { atMs: 10, processes: [row({ userTicks: 100, rssBytes: 9000 })] },
        { atMs: 20, processes: [] },
      ],
      0
    );
    expect(summary).toMatchObject({
      sampleCount: 1,
      peakSampledRssBytes: 1000,
      sampledUserCpuMs: 20,
      remainingIdentities: [],
    });
  });

  it('rejects decreasing CPU counters for the same process identity', () => {
    expect(() =>
      summarize([
        { atMs: 0, processes: [row()] },
        { atMs: 1, processes: [row({ userTicks: 1 })] },
      ])
    ).toThrow('expected nondecreasing CPU ticks');
  });

  it('rejects decreasing or nonfinite frame clocks', () => {
    expect(() =>
      summarize([
        { atMs: 2, processes: [] },
        { atMs: 1, processes: [] },
      ])
    ).toThrow('expected finite nondecreasing milliseconds');
    expect(() => summarize([{ atMs: Number.NaN, processes: [] }])).toThrow('received: NaN');
  });

  it('requires a usable CPU clock-tick frequency', () => {
    expect(() => summarizeProcessResources(ROOT, [], { ticksPerSecond: 0 })).toThrow(
      'ticksPerSecond: expected a positive safe integer | received: 0'
    );
  });
});
