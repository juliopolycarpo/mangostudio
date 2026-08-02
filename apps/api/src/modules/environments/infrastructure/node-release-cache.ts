import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  normalizeNodeVersion,
  parseExactNodeVersion,
} from '@mangostudio/shared/environments/detection';

const NODE_RELEASE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export interface NodeReleaseMetadata {
  readonly fetchedAtMs: number;
  readonly latestByMajor: ReadonlyMap<number, string>;
}

export interface NodeReleaseCacheIo {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly fetchIndex: () => Promise<unknown>;
}

export interface NodeReleaseCacheOptions {
  readonly enabled: boolean;
  readonly cacheFile: string;
  readonly force?: boolean;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly io?: NodeReleaseCacheIo;
}

interface CachedNodeReleaseMetadata {
  readonly fetchedAt: string;
  readonly latestByMajor: Record<string, string>;
}

function compareVersions(left: string, right: string): number {
  const leftVersion = parseExactNodeVersion(left);
  const rightVersion = parseExactNodeVersion(right);
  if (!leftVersion || !rightVersion) return left.localeCompare(right);
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  if (leftVersion.minor !== rightVersion.minor) return leftVersion.minor - rightVersion.minor;
  return leftVersion.patch - rightVersion.patch;
}

function parseLatestVersions(value: unknown): ReadonlyMap<number, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const latestByMajor = new Map<number, string>();
  for (const [rawMajor, rawVersion] of Object.entries(value)) {
    const major = Number(rawMajor);
    const version = typeof rawVersion === 'string' ? normalizeNodeVersion(rawVersion) : null;
    if (!Number.isSafeInteger(major) || major < 0 || !version) return null;
    if (parseExactNodeVersion(version)?.major !== major) return null;
    latestByMajor.set(major, version);
  }
  return latestByMajor.size > 0 ? latestByMajor : null;
}

function parseCachedMetadata(contents: string): NodeReleaseMetadata | null {
  try {
    const parsed = JSON.parse(contents) as Partial<CachedNodeReleaseMetadata>;
    const fetchedAtMs =
      typeof parsed.fetchedAt === 'string' ? Date.parse(parsed.fetchedAt) : Number.NaN;
    const latestByMajor = parseLatestVersions(parsed.latestByMajor);
    if (!Number.isFinite(fetchedAtMs) || !latestByMajor) return null;
    return { fetchedAtMs, latestByMajor };
  } catch {
    return null;
  }
}

function parseReleaseIndex(value: unknown): ReadonlyMap<number, string> | null {
  if (!Array.isArray(value)) return null;

  const latestByMajor = new Map<number, string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !('version' in entry)) continue;
    const version = typeof entry.version === 'string' ? normalizeNodeVersion(entry.version) : null;
    const parsed = version ? parseExactNodeVersion(version) : null;
    if (!version || !parsed) continue;

    const existing = latestByMajor.get(parsed.major);
    if (!existing || compareVersions(version, existing) > 0) {
      latestByMajor.set(parsed.major, version);
    }
  }
  return latestByMajor.size > 0 ? latestByMajor : null;
}

function serializeMetadata(metadata: NodeReleaseMetadata): string {
  const cache: CachedNodeReleaseMetadata = {
    fetchedAt: new Date(metadata.fetchedAtMs).toISOString(),
    latestByMajor: Object.fromEntries(
      [...metadata.latestByMajor.entries()].sort(([left], [right]) => left - right)
    ),
  };
  return `${JSON.stringify(cache, null, 2)}\n`;
}

function createDefaultIo(): NodeReleaseCacheIo {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
    rename,
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    fetchIndex: async () => {
      const response = await fetch(NODE_RELEASE_INDEX_URL, {
        signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Node release index returned HTTP ${response.status}.`);
      }
      return response.json();
    },
  };
}

async function readCachedMetadata(
  cacheFile: string,
  io: NodeReleaseCacheIo
): Promise<NodeReleaseMetadata | null> {
  try {
    return parseCachedMetadata(await io.readFile(cacheFile));
  } catch {
    return null;
  }
}

async function writeCachedMetadata(
  cacheFile: string,
  metadata: NodeReleaseMetadata,
  io: NodeReleaseCacheIo
): Promise<void> {
  // Concurrent forced probes bypass in-flight dedup, so the pid alone would let
  // two writers interleave into one temporary file and rename garbage into place.
  const temporaryFile = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await io.mkdir(dirname(cacheFile));
    await io.writeFile(temporaryFile, serializeMetadata(metadata));
    await io.rename(temporaryFile, cacheFile);
  } catch {
    // Detection still benefits from the live result when the cache is unwritable.
  }
}

export async function loadNodeReleaseMetadata(
  options: NodeReleaseCacheOptions
): Promise<NodeReleaseMetadata | null> {
  if (!options.enabled) return null;

  const io = options.io ?? createDefaultIo();
  const now = options.now?.() ?? Date.now();
  const cached = await readCachedMetadata(options.cacheFile, io);
  if (
    !options.force &&
    cached &&
    now - cached.fetchedAtMs >= 0 &&
    now - cached.fetchedAtMs < (options.ttlMs ?? DEFAULT_CACHE_TTL_MS)
  ) {
    return cached;
  }

  try {
    const latestByMajor = parseReleaseIndex(await io.fetchIndex());
    if (!latestByMajor) return cached;
    const metadata = { fetchedAtMs: now, latestByMajor };
    await writeCachedMetadata(options.cacheFile, metadata, io);
    return metadata;
  } catch {
    return cached;
  }
}
