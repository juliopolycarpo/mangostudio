import { describe, expect, it } from 'bun:test';
import {
  LIBRARY_SCAN_CACHE_TTL_MS,
  LibraryCache,
} from '../../../../src/modules/library/infrastructure/library-cache';

describe('LibraryCache', () => {
  it('does not recompute an unchanged path, size, and mtime fingerprint', async () => {
    const cache = new LibraryCache();
    let reads = 0;
    const compute = () => {
      reads += 1;
      return Promise.resolve({
        contentHash: 'a',
        sizeBytes: 4,
        whitespaceHash: 'a',
        display: {},
      });
    };

    const fingerprint = ['/skill', '4', '10'].join('\0');
    await cache.getOrComputeInstanceHash('/skill', fingerprint, false, compute);
    await cache.getOrComputeInstanceHash('/skill', fingerprint, false, compute);

    expect(reads).toBe(1);
  });

  it('rehashes a size change even when mtime is identical', async () => {
    const cache = new LibraryCache();
    let reads = 0;
    const compute = () => {
      reads += 1;
      return Promise.resolve({
        contentHash: String(reads),
        sizeBytes: reads,
        whitespaceHash: String(reads),
        display: {},
      });
    };

    await cache.getOrComputeInstanceHash(
      '/skill',
      ['/skill', '4', '10'].join('\0'),
      false,
      compute
    );
    await cache.getOrComputeInstanceHash(
      '/skill',
      ['/skill', '5', '10'].join('\0'),
      false,
      compute
    );

    expect(reads).toBe(2);
  });

  it('force bypasses both the instance cache and scan memo', async () => {
    const cache = new LibraryCache();
    let hashReads = 0;
    let scans = 0;
    const computeHash = () => {
      hashReads += 1;
      return Promise.resolve({
        contentHash: String(hashReads),
        sizeBytes: 1,
        whitespaceHash: String(hashReads),
        display: {},
      });
    };
    const computeScan = () => {
      scans += 1;
      return Promise.resolve([]);
    };

    await cache.getOrComputeInstanceHash('/skill', 'same', false, computeHash);
    await cache.getOrComputeInstanceHash('/skill', 'same', true, computeHash);
    await cache.getOrComputeScan('locations', 0, false, computeScan);
    await cache.getOrComputeScan('locations', LIBRARY_SCAN_CACHE_TTL_MS - 1, false, computeScan);
    await cache.getOrComputeScan('locations', LIBRARY_SCAN_CACHE_TTL_MS - 1, true, computeScan);

    expect(hashReads).toBe(2);
    expect(scans).toBe(2);
  });
});
