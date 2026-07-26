import type { LtsStatus } from '@mangostudio/shared/environments';

const DAY_MS = 24 * 60 * 60 * 1_000;
export const NODE_RELEASE_DATA_STALE_AFTER_MS = 183 * DAY_MS;

export interface NodeReleaseLine {
  readonly major: number;
  readonly start: string;
  readonly lts?: string;
  readonly maintenance: string;
  readonly end: string;
  readonly codename?: string;
  readonly latest?: string;
}

export interface NodeReleaseSchedule {
  readonly generatedAt: string;
  readonly lines: readonly NodeReleaseLine[];
}

export interface LtsPolicyOptions {
  readonly now: Date;
  readonly latestByMajor?: ReadonlyMap<number, string>;
  readonly liveDataAvailable?: boolean;
}

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseNodeVersion(value: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function normalizeNodeVersion(value: string): string | null {
  const version = parseNodeVersion(value);
  return version ? `${version.major}.${version.minor}.${version.patch}` : null;
}

function compareVersions(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function startOfDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function endOfDay(value: string): number {
  return startOfDay(value) + DAY_MS;
}

function isNodeReleaseScheduleStale(schedule: NodeReleaseSchedule, now: Date): boolean {
  const generatedAt = startOfDay(schedule.generatedAt);
  return (
    !Number.isFinite(generatedAt) || now.getTime() - generatedAt > NODE_RELEASE_DATA_STALE_AFTER_MS
  );
}

export function findNodeReleaseLine(
  schedule: NodeReleaseSchedule,
  version: string
): NodeReleaseLine | undefined {
  const parsed = parseNodeVersion(version);
  return parsed ? schedule.lines.find((line) => line.major === parsed.major) : undefined;
}

function newestActiveLtsMajor(schedule: NodeReleaseSchedule, nowMs: number): number | undefined {
  return schedule.lines
    .filter(
      (line) =>
        line.lts !== undefined && nowMs >= startOfDay(line.lts) && nowMs < endOfDay(line.end)
    )
    .reduce<number | undefined>(
      (latest, line) => (latest === undefined || line.major > latest ? line.major : latest),
      undefined
    );
}

function latestVersionForLine(
  line: NodeReleaseLine,
  latestByMajor: ReadonlyMap<number, string> | undefined
): SemVer | null {
  const bundled = parseNodeVersion(line.latest ?? '');
  const supplemental = parseNodeVersion(latestByMajor?.get(line.major) ?? '');
  if (!bundled) return supplemental;
  if (!supplemental) return bundled;
  return compareVersions(supplemental, bundled) > 0 ? supplemental : bundled;
}

export function classifyNodeLtsStatus(
  versionValue: string,
  schedule: NodeReleaseSchedule,
  options: LtsPolicyOptions
): LtsStatus {
  if (isNodeReleaseScheduleStale(schedule, options.now) && options.liveDataAvailable !== true) {
    return 'unknown';
  }

  const version = parseNodeVersion(versionValue);
  if (!version) return 'unknown';

  const line = schedule.lines.find((candidate) => candidate.major === version.major);
  if (!line) return 'unknown';

  const nowMs = options.now.getTime();
  if (nowMs < startOfDay(line.start)) return 'unknown';
  if (nowMs >= endOfDay(line.end)) return 'end-of-life';

  if (line.lts === undefined || nowMs < startOfDay(line.lts)) {
    return 'current-release';
  }

  if (version.major !== newestActiveLtsMajor(schedule, nowMs)) {
    return 'lts-superseded';
  }

  const latest = latestVersionForLine(line, options.latestByMajor);
  if (!latest) return 'unknown';
  return compareVersions(version, latest) < 0 ? 'lts-outdated-patch' : 'current-lts';
}
