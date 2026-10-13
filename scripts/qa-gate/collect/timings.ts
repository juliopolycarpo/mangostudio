// Advisory wall-clock receipts for the existing serial collector. They are a
// separate artifact, never an input to the QA envelope or its verdict.

import type { Provenance } from '../model/envelope';

export type TimeCollector = <T>(label: string, collect: () => Promise<T>) => Promise<T>;

export interface CollectorTiming {
  readonly label: string;
  readonly startedAfterMs: number;
  readonly durationMs: number;
  /** Whether the function returned; this is not a measurement or QA verdict. */
  readonly outcome: 'returned' | 'threw';
  readonly parentRssBeforeBytes: number | null;
  readonly parentRssAfterBytes: number | null;
}

interface TimingClock {
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly rss: () => number;
}

const CLOCK: TimingClock = {
  now: () => performance.now(),
  timestamp: () => new Date().toISOString(),
  rss: () => process.memoryUsage().rss,
};

const sampleRss = (clock: TimingClock): number | null => {
  try {
    const rss = clock.rss();
    return Number.isFinite(rss) && rss >= 0 ? rss : null;
  } catch {
    // Telemetry cannot change a collector's result.
    return null;
  }
};

export const collectWithoutTiming: TimeCollector = (_label, collect) => collect();

/** Times a function without catching or changing its result/failure. */
export class CollectorTimings {
  private readonly started: number;
  private readonly startedAt: string;
  private readonly entries: CollectorTiming[] = [];

  constructor(private readonly clock: TimingClock = CLOCK) {
    this.started = clock.now();
    this.startedAt = clock.timestamp();
  }

  readonly time: TimeCollector = async (label, collect) => {
    const started = this.clock.now();
    const parentRssBeforeBytes = sampleRss(this.clock);
    let outcome: CollectorTiming['outcome'] = 'threw';
    try {
      const result = await collect();
      outcome = 'returned';
      return result;
    } finally {
      this.entries.push({
        label,
        startedAfterMs: started - this.started,
        durationMs: this.clock.now() - started,
        outcome,
        parentRssBeforeBytes,
        parentRssAfterBytes: sampleRss(this.clock),
      });
    }
  };

  receipt(
    identity: {
      readonly repository: string;
      readonly checkoutSha: string;
      readonly provenance: Provenance;
    },
    status: 'completed' | 'failed',
    env: Readonly<Record<string, string | undefined>> = process.env
  ) {
    return {
      schemaVersion: 1,
      mode: 'serial',
      status,
      ...identity,
      startedAt: this.startedAt,
      finishedAt: this.clock.timestamp(),
      durationMs: this.clock.now() - this.started,
      runtime: { bunVersion: Bun.version, platform: process.platform, arch: process.arch },
      runner: {
        environment: env.RUNNER_ENVIRONMENT ?? null,
        os: env.RUNNER_OS ?? null,
        arch: env.RUNNER_ARCH ?? null,
        image: env.ImageOS ?? null,
        imageVersion: env.ImageVersion ?? null,
      },
      memoryScope: 'parent-process-rss-snapshots',
      // Nested spans overlap (components contains its per-component spans), so
      // consumers must not sum them as independent costs.
      entries: [...this.entries],
    } as const;
  }
}
