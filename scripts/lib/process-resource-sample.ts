import { type NativeProcess, scopeNativeProcesses } from './native-bun-qualification-process';

/** Linux process-resource observations; CPU counters and RSS are sampled, not inferred peaks. */
export interface ProcessResourceRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
  readonly command: string;
  readonly startTicks: number;
  readonly userTicks: number;
  readonly systemTicks: number;
  readonly rssBytes: number;
}

export interface ProcessResourceIdentity {
  readonly pid: number;
  readonly startTicks: number;
}

export interface ProcessResourceFrame {
  readonly atMs: number;
  readonly processes: readonly ProcessResourceRow[];
}

export interface ProcessResourceSummary {
  readonly sampleCount: number;
  readonly observedProcessCount: number;
  readonly peakSampledRssBytes: number | null;
  readonly sampledUserCpuMs: number | null;
  readonly sampledSystemCpuMs: number | null;
  readonly cpuResolutionMs: number;
  readonly remainingIdentities: readonly string[];
  /** Only owned rows, including observations after the measurement window for cleanup. */
  readonly frames: readonly ProcessResourceFrame[];
}

function nonnegativeInteger(value: string | undefined, label: string): number {
  if (value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
  throw new Error(`${label}: expected a nonnegative safe integer | received: ${String(value)}`);
}

/**
 * Parses /proc/PID/stat, including command names containing spaces or parentheses.
 * Example: parseLinuxProcessResourceStat(pid, statText, 4096).
 */
export function parseLinuxProcessResourceStat(
  pid: number,
  text: string,
  pageBytes: number
): ProcessResourceRow {
  const match = /^(\d+) \((.*)\) (.*)$/s.exec(text.trim());
  if (!match || Number(match[1]) !== pid) {
    throw new Error(
      `/proc/${pid}/stat: expected matching pid (comm) fields | received: ${JSON.stringify(text)}`
    );
  }
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0) {
    throw new Error(`pageBytes: expected a positive safe integer | received: ${pageBytes}`);
  }
  const fields = match[3].split(/\s+/);
  const read = (index: number, field: string) =>
    nonnegativeInteger(fields[index], `/proc/${pid}/stat ${field}`);
  const rssBytes = read(21, 'rss pages') * pageBytes;
  if (!Number.isSafeInteger(rssBytes)) {
    throw new Error(`/proc/${pid}/stat rss bytes: expected a safe integer | received: ${rssBytes}`);
  }
  return {
    pid,
    parentPid: read(1, 'parent pid'),
    group: read(2, 'process group'),
    command: match[2],
    startTicks: read(19, 'start ticks'),
    userTicks: read(11, 'user ticks'),
    systemTicks: read(12, 'system ticks'),
    rssBytes,
  };
}

function identity(row: ProcessResourceIdentity): string {
  return `${row.pid}:${row.startTicks}`;
}

function ownedRows(
  rows: readonly ProcessResourceRow[],
  root: ProcessResourceIdentity,
  known: Map<string, NativeProcess>
): ProcessResourceRow[] {
  const byIdentity = new Map(rows.map((row) => [identity(row), row]));
  const currentRoot = rows.find((row) => row.pid === root.pid);
  const scoped = scopeNativeProcesses(
    rows.map((row) => ({ ...row, identity: identity(row) })),
    {
      rootPid: root.pid,
      rootAlive: currentRoot?.startTicks === root.startTicks,
      rootIdentity: identity(root),
      observed: [...known.values()],
    }
  );
  for (const row of scoped.observed) known.set(row.identity, row);
  return scoped.current.map((row) => byIdentity.get(row.identity) as ProcessResourceRow);
}

/** Retains owned observations without unrelated host processes. Example: new ProcessResourceTracker(root). */
export class ProcessResourceTracker {
  private readonly known = new Map<string, NativeProcess>();
  private readonly recorded: ProcessResourceFrame[] = [];

  constructor(private readonly root: ProcessResourceIdentity) {}

  /** Adds a census, retaining descendants across reparenting. Example: tracker.observe(frame). */
  observe(frame: ProcessResourceFrame): void {
    this.recorded.push({
      atMs: frame.atMs,
      processes: ownedRows(frame.processes, this.root, this.known).map((row) => ({ ...row })),
    });
  }

  /** Returns observations, including failed-attempt diagnostics. Example: tracker.frames(). */
  frames(): readonly ProcessResourceFrame[] {
    return this.recorded;
  }

  /** Summarizes the recorded tree. Example: tracker.summarize({ ticksPerSecond: 100 }). */
  summarize(options: ProcessResourceSummaryOptions): ProcessResourceSummary {
    return summarizeProcessResources(this.root, this.recorded, options);
  }
}

export interface ProcessResourceSummaryOptions {
  readonly ticksPerSecond: number;
  /** May be negative when readiness preceded monitor initialization; no frame then qualifies. */
  readonly measurementEndMs?: number;
  /** Preserve wrapper ownership/raw rows while excluding its resource cost. */
  readonly omitRootFromMetrics?: boolean;
}

/**
 * Tracks descendants by pid/start ticks, retaining exited members' last CPU observations.
 * RSS is the largest observed sum, with shared pages counted in each process. Missing data is null.
 * Example: summarizeProcessResources(root, frames, { ticksPerSecond: 100 }).
 */
export function summarizeProcessResources(
  root: ProcessResourceIdentity,
  frames: readonly ProcessResourceFrame[],
  options: ProcessResourceSummaryOptions
): ProcessResourceSummary {
  if (!Number.isSafeInteger(options.ticksPerSecond) || options.ticksPerSecond <= 0) {
    throw new Error(
      `ticksPerSecond: expected a positive safe integer | received: ${options.ticksPerSecond}`
    );
  }
  if (options.measurementEndMs !== undefined && !Number.isFinite(options.measurementEndMs)) {
    throw new Error(
      `measurementEndMs: expected finite milliseconds relative to observation origin | received: ${options.measurementEndMs}`
    );
  }
  const known = new Map<string, NativeProcess>();
  const measured = new Map<string, ProcessResourceRow>();
  const ownedFrames: ProcessResourceFrame[] = [];
  let peak: number | null = null;
  let sampleCount = 0;
  let lastAtMs = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.atMs) || frame.atMs < lastAtMs) {
      throw new Error(
        `process frame time: expected finite nondecreasing milliseconds | received: ${frame.atMs}`
      );
    }
    lastAtMs = frame.atMs;
    const rows = ownedRows(frame.processes, root, known);
    ownedFrames.push({ atMs: frame.atMs, processes: rows });
    const metricRows = options.omitRootFromMetrics
      ? rows.filter((row) => identity(row) !== identity(root))
      : rows;
    if (
      frame.atMs > (options.measurementEndMs ?? Number.POSITIVE_INFINITY) ||
      metricRows.length === 0
    )
      continue;
    sampleCount += 1;
    peak = Math.max(
      peak ?? 0,
      metricRows.reduce((sum, row) => sum + row.rssBytes, 0)
    );
    for (const row of metricRows) {
      const previous = measured.get(identity(row));
      if (
        previous &&
        (row.userTicks < previous.userTicks || row.systemTicks < previous.systemTicks)
      ) {
        throw new Error(
          `process ${identity(row)}: expected nondecreasing CPU ticks | received: ${row.userTicks}/${row.systemTicks}`
        );
      }
      measured.set(identity(row), row);
    }
  }
  const ticks = [...measured.values()];
  const cpu = (field: 'userTicks' | 'systemTicks') =>
    ticks.length === 0
      ? null
      : (ticks.reduce((sum, row) => sum + row[field], 0) * 1000) / options.ticksPerSecond;
  return {
    sampleCount,
    observedProcessCount: measured.size,
    peakSampledRssBytes: peak,
    sampledUserCpuMs: cpu('userTicks'),
    sampledSystemCpuMs: cpu('systemTicks'),
    cpuResolutionMs: 1000 / options.ticksPerSecond,
    remainingIdentities: (ownedFrames.at(-1)?.processes ?? []).map(identity),
    frames: ownedFrames,
  };
}
