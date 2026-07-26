import { join } from 'node:path';

const SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const RELEASE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const OUTPUT_FILE = join(
  import.meta.dir,
  '../apps/api/src/modules/environments/domain/node-release-schedule.ts'
);
const MINIMUM_MAJOR = 16;

interface UpstreamScheduleLine {
  readonly start?: unknown;
  readonly lts?: unknown;
  readonly maintenance?: unknown;
  readonly end?: unknown;
  readonly codename?: unknown;
}

export interface GeneratedScheduleLine {
  readonly major: number;
  readonly start: string;
  readonly lts?: string;
  readonly maintenance: string;
  readonly end: string;
  readonly codename?: string;
  readonly latest?: string;
}

function requiredDate(value: unknown, field: string, major: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Node ${major} has an invalid ${field} date.`);
  }
  return value;
}

function optionalDate(value: unknown, field: string, major: number): string | undefined {
  return value === undefined ? undefined : requiredDate(value, field, major);
}

function parseMajor(value: string): number | null {
  const match = /^v(\d+)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function latestVersionsFromIndex(index: unknown): ReadonlyMap<number, string> {
  if (!Array.isArray(index)) throw new Error('Node release index must be an array.');

  const latestByMajor = new Map<number, string>();
  for (const row of index) {
    if (!row || typeof row !== 'object' || !('version' in row)) continue;
    const version = normalizeVersion(row.version);
    if (!version) continue;
    const major = Number(version.split('.')[0]);
    const previous = latestByMajor.get(major);
    if (!previous || compareVersions(version, previous) > 0) {
      latestByMajor.set(major, version);
    }
  }
  if (latestByMajor.size === 0) throw new Error('Node release index has no valid versions.');
  return latestByMajor;
}

export function scheduleLinesFromUpstream(
  schedule: unknown,
  latestByMajor: ReadonlyMap<number, string>,
  minimumMajor = MINIMUM_MAJOR
): GeneratedScheduleLine[] {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('Node release schedule must be an object.');
  }

  return Object.entries(schedule)
    .map(([rawMajor, rawLine]) => {
      const major = parseMajor(rawMajor);
      if (major === null || major < minimumMajor) return null;
      if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) {
        throw new Error(`Node ${major} schedule entry must be an object.`);
      }
      const line = rawLine as UpstreamScheduleLine;
      const lts = optionalDate(line.lts, 'lts', major);
      const codename =
        typeof line.codename === 'string' && line.codename.trim()
          ? line.codename.trim().toLowerCase()
          : undefined;
      const latest = latestByMajor.get(major);
      return {
        major,
        start: requiredDate(line.start, 'start', major),
        ...(lts !== undefined && { lts }),
        maintenance: requiredDate(line.maintenance, 'maintenance', major),
        end: requiredDate(line.end, 'end', major),
        ...(codename !== undefined && { codename }),
        ...(latest !== undefined && { latest }),
      };
    })
    .filter((line): line is GeneratedScheduleLine => line !== null)
    .sort((left, right) => left.major - right.major);
}

function renderProperty(name: string, value: string | number, indentation = 6): string {
  const rendered = typeof value === 'number' ? String(value) : `'${value}'`;
  return `${' '.repeat(indentation)}${name}: ${rendered},`;
}

export function renderNodeReleaseSchedule(
  generatedAt: string,
  lines: readonly GeneratedScheduleLine[]
): string {
  requiredDate(generatedAt, 'generatedAt', 0);
  const renderedLines = lines
    .map((line) => {
      const properties = [
        renderProperty('major', line.major),
        renderProperty('start', line.start),
        ...(line.lts !== undefined ? [renderProperty('lts', line.lts)] : []),
        renderProperty('maintenance', line.maintenance),
        renderProperty('end', line.end),
        ...(line.codename !== undefined ? [renderProperty('codename', line.codename)] : []),
        ...(line.latest !== undefined ? [renderProperty('latest', line.latest)] : []),
      ];
      return `    {\n${properties.join('\n')}\n    },`;
    })
    .join('\n');

  return `import type { NodeReleaseSchedule } from './lts-policy';

/**
 * Generated by scripts/update-node-release-schedule.ts from nodejs/Release and
 * nodejs.org/dist/index.json. Do not edit by hand.
 */
export const NODE_RELEASE_SCHEDULE = {
  generatedAt: '${generatedAt}',
  lines: [
${renderedLines}
  ],
} as const satisfies NodeReleaseSchedule;
`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function main(): Promise<void> {
  const [schedule, releaseIndex] = await Promise.all([
    fetchJson(SCHEDULE_URL),
    fetchJson(RELEASE_INDEX_URL),
  ]);
  const latestByMajor = latestVersionsFromIndex(releaseIndex);
  const lines = scheduleLinesFromUpstream(schedule, latestByMajor);
  const generatedAt = new Date().toISOString().slice(0, 10);
  await Bun.write(OUTPUT_FILE, renderNodeReleaseSchedule(generatedAt, lines));
  console.log(`Updated ${OUTPUT_FILE} with ${lines.length} Node release lines.`);
}

if (import.meta.main) {
  await main();
}
