import { readLinuxProcessResources } from './process-resource-host';
import {
  type ProcessResourceFrame,
  type ProcessResourceRow,
  type ProcessResourceSummary,
  ProcessResourceTracker,
} from './process-resource-sample';

export interface ProcessResourceMonitorHost {
  readonly snapshot: () => Promise<readonly ProcessResourceRow[]>;
  readonly now: () => number;
  readonly repeat: (callback: () => void, intervalMs: number) => () => void;
}

export interface ProcessResourceObservation {
  readonly intervalMs: number;
  readonly clockOriginMs: number;
  readonly readinessAtMs: number | null;
  readonly measurementEndMs: number | null;
  readonly errors: readonly string[];
  readonly summary: ProcessResourceSummary | null;
  readonly frames: readonly ProcessResourceFrame[];
}

export interface ProcessResourceMonitor {
  /** Capture the resource endpoint before starting child cleanup. */
  readonly markReady: (readinessAtMs?: number) => Promise<void>;
  /** After child termination, capture remaining identities and settle all sampling. */
  readonly stop: () => Promise<ProcessResourceObservation>;
}

function liveHost(pageBytes: number): ProcessResourceMonitorHost {
  return {
    snapshot: () => readLinuxProcessResources(pageBytes),
    now: () => performance.now(),
    repeat: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return () => clearInterval(timer);
    },
  };
}

/**
 * Samples a real child's tree without overlapping censuses. Initial identity is read before polling.
 * Example: const monitor = await startProcessResourceMonitor(pid, { pageBytes: 4096, ticksPerSecond: 100 });
 */
export async function startProcessResourceMonitor(
  pid: number,
  options: {
    readonly pageBytes: number;
    readonly ticksPerSecond: number;
    readonly intervalMs?: number;
    readonly host?: ProcessResourceMonitorHost;
  }
): Promise<ProcessResourceMonitor> {
  const intervalMs = options.intervalMs ?? 10;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `resource intervalMs: expected positive finite milliseconds | received: ${intervalMs}`
    );
  }
  const host = options.host ?? liveHost(options.pageBytes);
  const started = host.now();
  const first = await host.snapshot();
  const root = first.find((row) => row.pid === pid);
  if (!root) throw new Error(`resource root: expected live pid ${pid} | received: absent`);
  const tracker = new ProcessResourceTracker(root);
  tracker.observe({ atMs: host.now() - started, processes: first });
  const errors: string[] = [];
  let pending: Promise<void> | undefined;
  let stopped: Promise<ProcessResourceObservation> | undefined;
  let closed = false;
  let measurementEndMs: number | undefined;
  let readinessAtMs: number | null = null;

  const capture = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => host.snapshot())
      .then((rows) => tracker.observe({ atMs: host.now() - started, processes: rows }))
      .catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const cancel = host.repeat(() => {
    void capture();
  }, intervalMs);

  const finish = async (): Promise<ProcessResourceObservation> => {
    cancel();
    await pending;
    await capture();
    closed = true;
    let summary: ProcessResourceSummary | null = null;
    try {
      summary = tracker.summarize({ ticksPerSecond: options.ticksPerSecond, measurementEndMs });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return {
      intervalMs,
      clockOriginMs: started,
      readinessAtMs,
      measurementEndMs: measurementEndMs ?? null,
      errors: [...errors],
      summary,
      frames: tracker.frames(),
    };
  };

  return {
    markReady: async (readyAt = host.now()) => {
      if (stopped)
        throw new Error('resource monitor: expected running sampler | received: stopped');
      if (!Number.isFinite(readyAt) || readyAt > host.now())
        throw new Error(
          `resource readiness timestamp: expected finite monotonic time no later than now | received: ${readyAt}`
        );
      readinessAtMs = readyAt;
      measurementEndMs = readyAt - started;
      await capture();
    },
    stop: () => {
      stopped ??= finish();
      return stopped;
    },
  };
}
