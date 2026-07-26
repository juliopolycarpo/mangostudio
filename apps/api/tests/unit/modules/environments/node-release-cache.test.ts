import { describe, expect, it } from 'bun:test';
import {
  loadNodeReleaseMetadata,
  type NodeReleaseCacheIo,
} from '../../../../src/modules/environments/infrastructure/node-release-cache';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const CACHE_FILE = '/home/tester/.mango/cache/node-releases.json';

function createIo(
  cached: string | undefined,
  index: unknown = [
    { version: 'v24.18.0', lts: 'Krypton' },
    { version: 'v24.17.0', lts: 'Krypton' },
    { version: 'v26.5.0', lts: false },
  ]
) {
  let fetchCount = 0;
  let written: string | undefined;
  const io: NodeReleaseCacheIo = {
    readFile: () =>
      cached === undefined ? Promise.reject(new Error('cache missing')) : Promise.resolve(cached),
    writeFile: (_path, contents) => {
      written = contents;
      return Promise.resolve();
    },
    rename: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    fetchIndex: () => {
      fetchCount += 1;
      return index instanceof Error ? Promise.reject(index) : Promise.resolve(index);
    },
  };
  return { io, getFetchCount: () => fetchCount, getWritten: () => written };
}

function cachedMetadata(fetchedAt: string): string {
  return JSON.stringify({
    fetchedAt,
    latestByMajor: { 22: '22.23.1', 24: '24.18.0' },
  });
}

describe('loadNodeReleaseMetadata', () => {
  it('does not read or fetch release data when refresh is disabled', async () => {
    const { io, getFetchCount } = createIo(undefined);

    const metadata = await loadNodeReleaseMetadata({
      enabled: false,
      cacheFile: CACHE_FILE,
      io,
    });

    expect(metadata).toBeNull();
    expect(getFetchCount()).toBe(0);
  });

  it('uses a fresh 24-hour cache without fetching', async () => {
    const { io, getFetchCount } = createIo(cachedMetadata('2026-07-26T00:00:00.000Z'));

    const metadata = await loadNodeReleaseMetadata({
      enabled: true,
      cacheFile: CACHE_FILE,
      now: () => NOW,
      io,
    });

    expect(metadata?.latestByMajor.get(24)).toBe('24.18.0');
    expect(getFetchCount()).toBe(0);
  });

  it('refreshes an expired cache and stores only the newest patch per line', async () => {
    const { io, getFetchCount, getWritten } = createIo(cachedMetadata('2026-07-24T00:00:00.000Z'));

    const metadata = await loadNodeReleaseMetadata({
      enabled: true,
      cacheFile: CACHE_FILE,
      now: () => NOW,
      io,
    });

    expect(metadata?.latestByMajor.get(24)).toBe('24.18.0');
    expect(metadata?.latestByMajor.get(26)).toBe('26.5.0');
    expect(getFetchCount()).toBe(1);
    expect(getWritten()).toContain('"fetchedAt": "2026-07-26T12:00:00.000Z"');
  });

  it('falls back to an expired cache when the network is unavailable', async () => {
    const { io } = createIo(cachedMetadata('2026-07-20T00:00:00.000Z'), new Error('offline'));

    const metadata = await loadNodeReleaseMetadata({
      enabled: true,
      cacheFile: CACHE_FILE,
      now: () => NOW,
      io,
    });

    expect(metadata?.latestByMajor.get(22)).toBe('22.23.1');
    expect(metadata?.fetchedAtMs).toBe(Date.parse('2026-07-20T00:00:00.000Z'));
  });
});
