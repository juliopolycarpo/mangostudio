import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GLOB_PATTERNS,
  parseCandidate,
  prepareWorkload,
  REQUEST_SCENARIOS,
  textOfSize,
  treePaths,
} from '../bench/runtime-requests';

describe('runtime-requests benchmark fixtures', () => {
  it('builds unique tree paths with the expected count and both directory shapes', () => {
    const paths = treePaths(2, 10, 5);

    // 2 packages x 10 modules x 5 files, plus one spec file for module 0 of each package.
    expect(paths).toHaveLength(2 * 10 * 5 + 2);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('pkg-1/test/mod-0.spec.ts');
    expect(paths).toContain('pkg-0/src/mod-9/file-4.json');
  });

  it('builds text of at least the requested size in 81-byte lines', () => {
    const text = textOfSize(1_000);

    expect(text.length).toBeGreaterThanOrEqual(1_000);
    expect(text.length % 81).toBe(0);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps glob patterns distinct so no compile is measured twice', () => {
    expect(new Set(GLOB_PATTERNS).size).toBe(GLOB_PATTERNS.length);
  });

  it('labels a bare binary and a label=path pair', () => {
    expect(parseCandidate('x/bin').label).toBe('binary');
    expect(parseCandidate('head=x/bin')).toEqual({
      label: 'head',
      binary: parseCandidate('x/bin').binary,
    });
  });

  it('prepares every scenario, writing its fixture and a batch size', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'requests-bench-test-'));
    try {
      for (const scenario of REQUEST_SCENARIOS) {
        const workload = await prepareWorkload(scenario, scratch, {
          patternFiles: 400,
          listFiles: 1_000,
          payloadMiB: 1,
        });
        expect(workload.callsPerSample).toBeGreaterThan(0);
      }
      expect((await readFile(join(scratch, 'small.txt'), 'utf8')).length).toBeGreaterThanOrEqual(
        1_024
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
