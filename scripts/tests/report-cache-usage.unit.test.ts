import { describe, expect, test } from 'bun:test';

import {
  type CacheEntry,
  cacheFamily,
  formatBytes,
  renderCacheSummary,
} from '../ci/report-cache-usage';

const MB = 1024 ** 2;

function entry(key: string, sizeInBytes: number): CacheEntry {
  return { key, sizeInBytes };
}

describe('cacheFamily', () => {
  test('reads the family segment out of a scoped cache key', () => {
    // `<os>-<arch>-<epoch>-<family>-<scope>-<validity>`, as cache-scoped builds it.
    expect(cacheFamily('Linux-X64-v1-turbo-main-check-bun-1.4.0-canary.1+32e87032b')).toBe('turbo');
    expect(cacheFamily('Linux-X64-v1-bun-pr-894-32e87032b-abc123')).toBe('bun');
    expect(cacheFamily('macOS-ARM64-v1-playwright-main-1.50.0')).toBe('playwright');
  });

  test('reports an unrecognized key under itself rather than guessing', () => {
    // A wrong attribution reads as a family growing when it is not, which is
    // exactly the signal this summary exists to give.
    expect(cacheFamily('some-other-key')).toBe('some-other-key');
    expect(cacheFamily('setup-bun')).toBe('setup-bun');
  });
});

describe('formatBytes', () => {
  test('scales to the unit that keeps the number readable', () => {
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(340 * MB)).toBe('340 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB');
  });
});

describe('renderCacheSummary', () => {
  test('states the share of the budget in use', () => {
    const summary = renderCacheSummary({ totalBytes: 5 * 1024 ** 3, entryCount: 42 }, []);

    expect(summary).toContain('5.00 GB of 10.00 GB (50.0%) across 42 entries');
    // Nothing to rank, so no empty table.
    expect(summary).not.toContain('| Family |');
  });

  test('ranks families by the space they hold', () => {
    const summary = renderCacheSummary({ totalBytes: 900 * MB, entryCount: 4 }, [
      entry('Linux-X64-v1-turbo-main-check-a', 500 * MB),
      entry('Linux-X64-v1-turbo-main-build-b', 100 * MB),
      entry('Linux-X64-v1-playwright-main-c', 300 * MB),
    ]);
    const rows = summary
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.includes('---'));

    expect(rows[0]).toContain('| Family |');
    expect(rows[1]).toBe('| turbo | 600 MB | 2 |');
    expect(rows[2]).toBe('| playwright | 300 MB | 1 |');
  });

  test('sums the tail into one row rather than listing every family', () => {
    const entries = Array.from({ length: 9 }, (_, index) =>
      entry(`Linux-X64-v1-family${index}-main-key`, (9 - index) * MB)
    );

    const summary = renderCacheSummary({ totalBytes: 45 * MB, entryCount: 9 }, entries);

    expect(summary).toContain('| family0 | 9 MB | 1 |');
    // Six shown, so the remaining three collapse.
    expect(summary).toContain('| other (3) | 6 MB | 3 |');
    expect(summary).not.toContain('| family6 |');
  });
});
