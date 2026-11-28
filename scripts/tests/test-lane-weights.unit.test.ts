/**
 * The tracked weights that balance a worker lane's split. A weights manifest is
 * source, so these checks keep it honest without timing anything: every listed
 * path is a file the lane owns, every weight is a whole number of seconds above
 * the default, and the split they give is a pure function of the commit.
 */
import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  LANE_WEIGHTS,
  laneWeights,
  NO_HOST_FACTS,
  POWERSHELL_HOST_WEIGHTS,
  WINDOWS_LANE_WEIGHTS,
} from '../lib/test-lane-weights';
import { TEST_LANES } from '../lib/test-lanes';
import {
  DEFAULT_FILE_WEIGHT,
  discoverTestFiles,
  partitionByWeight,
  resolveWorkerCount,
} from '../lib/test-workers';

const WEIGHTED_LANES = TEST_LANES.flatMap((lane) => {
  const weights = LANE_WEIGHTS[lane.id];
  return weights && lane.workers
    ? [{ lane, weights, workers: lane.workers, platform: 'linux' as NodeJS.Platform }]
    : [];
});

/** The lanes with a table of their own on Windows, checked the same way as the shared tables. */
const WINDOWS_WEIGHTED_LANES = TEST_LANES.flatMap((lane) => {
  const weights = WINDOWS_LANE_WEIGHTS[lane.id];
  return weights && lane.workers
    ? [{ lane, weights, workers: lane.workers, platform: 'win32' as NodeJS.Platform }]
    : [];
});

/** The files a lane owns, spelled as its census spells them: relative to the lane's workspace. */
const ownedFiles = (lane: (typeof TEST_LANES)[number]): string[] => {
  const workers = lane.workers;
  if (!workers) return [];
  const cwd = join(ROOT_DIR, dirname(lane.manifest));
  return [...discoverTestFiles(cwd, workers.testDir), ...(workers.alsoRuns ?? [])].sort();
};

it('weights the root and api-integration lanes and leaves api-unit on --shard', () => {
  const weighted = Object.keys(LANE_WEIGHTS);

  expect(
    WEIGHTED_LANES.map(({ lane }) => lane.id as string),
    `(worker weights): expected a worker lane for each weighted id | received: ${weighted.join(', ')}`
  ).toEqual(weighted);
  expect(weighted).toEqual(['root', 'api-integration']);
});

it('gives only lanes that split by weight a Windows table, and the root lane one', () => {
  expect(Object.keys(WINDOWS_LANE_WEIGHTS)).toEqual(['root']);
  expect(laneWeights('root', 'win32')).toBe(WINDOWS_LANE_WEIGHTS.root);
  expect(laneWeights('api-integration', 'win32')).toBe(LANE_WEIGHTS['api-integration']);
  expect(laneWeights('root', 'linux')).toBe(LANE_WEIGHTS.root);
  expect(
    laneWeights('api-unit', 'win32'),
    '(worker weights): expected api-unit on --shard'
  ).toBeUndefined();
});

describe('the weights that apply only on a host with PowerShell', () => {
  const entries = Object.entries(POWERSHELL_HOST_WEIGHTS).flatMap(([laneId, weights]) =>
    Object.entries(weights ?? {}).map(([path, weight]) => ({ laneId, path, weight }))
  );

  it('weighs the install layout suite and nothing else', () => {
    expect(entries.map(({ path }) => path)).toEqual([
      'scripts/tests/install-ps1-layout.unit.test.ts',
    ]);
  });

  it('lists only files the lane owns, none of them in the CI table, with whole-second weights', () => {
    for (const { laneId, path, weight } of entries) {
      const lane = TEST_LANES.find((candidate) => candidate.id === laneId);
      expect(
        lane && ownedFiles(lane).includes(path),
        `(worker weights): expected a ${laneId} lane test file | received: ${path}`
      ).toBe(true);
      expect(
        LANE_WEIGHTS[laneId as keyof typeof LANE_WEIGHTS]?.[path],
        `(worker weights): expected ${path} absent from the CI table so a CI refresh cannot lose or double it | received: listed`
      ).toBeUndefined();
      expect(
        Number.isInteger(weight) && weight > DEFAULT_FILE_WEIGHT,
        `(worker weights): expected an integer above ${DEFAULT_FILE_WEIGHT} for ${path} | received: ${weight}`
      ).toBe(true);
    }
  });

  it('is added on POSIX with PowerShell and nowhere else', () => {
    const path = 'scripts/tests/install-ps1-layout.unit.test.ts';

    expect(laneWeights('root', 'linux', { powershell: true })?.[path]).toBe(
      POWERSHELL_HOST_WEIGHTS.root?.[path]
    );
    expect(laneWeights('root', 'linux', NO_HOST_FACTS)).toBe(LANE_WEIGHTS.root);
    expect(laneWeights('root', 'linux')).toBe(LANE_WEIGHTS.root);
    expect(laneWeights('root', 'win32', { powershell: true })).toBe(WINDOWS_LANE_WEIGHTS.root);
    expect(laneWeights('api-unit', 'linux', { powershell: true })).toBeUndefined();
  });
});

describe.each([...WEIGHTED_LANES, ...WINDOWS_WEIGHTED_LANES])(
  'the $lane.id lane worker weights on $platform',
  ({ lane, weights, workers, platform }) => {
    const listed = Object.entries(weights);

    it('lists the heavy test files', () => {
      expect(
        listed.length,
        `(worker weights): expected ${lane.id} to list its heavy test files | received: ${listed.length}`
      ).toBeGreaterThan(3);
    });

    it(`lists only test files ${lane.id} owns`, () => {
      const owned = new Set(ownedFiles(lane));
      for (const [path] of listed) {
        expect(
          owned.has(path),
          `(worker weights): expected a ${lane.id} lane test file | received: ${path}`
        ).toBe(true);
      }
    });

    it('gives each file a whole number of seconds above the default weight', () => {
      for (const [path, weight] of listed) {
        expect(
          Number.isInteger(weight) && weight > DEFAULT_FILE_WEIGHT,
          `(worker weights): expected an integer above ${DEFAULT_FILE_WEIGHT} for ${path} | received: ${weight}`
        ).toBe(true);
      }
    });

    it('keeps the listing in path order so a refresh is a small diff', () => {
      const paths = listed.map(([path]) => path);
      const sorted = [...paths].sort();
      const firstOut = paths.find((path, at) => path !== sorted[at]);

      expect(
        firstOut,
        `(worker weights): expected paths in code-unit order | received: ${firstOut} out of place`
      ).toBeUndefined();
    });

    it.each([2, 4, 6, 8])(
      'splits the lane the same way at %i workers, whatever order it arrives in',
      (count) => {
        const files = ownedFiles(lane);
        const first = partitionByWeight(files, weights, count);

        expect(partitionByWeight([...files].reverse(), weights, count)).toEqual(first);
        expect(
          first.flat().sort(),
          `(${lane.id} split): expected each of ${files.length} files in one worker | received: ${first.flat().length} placed`
        ).toEqual(files);
        expect(
          first.findIndex((group) => group.length === 0),
          `(${lane.id} split): expected a file for each of ${count} workers | received: an empty worker`
        ).toBe(-1);
      }
    );

    it('puts the heaviest files on different workers at the default width', () => {
      const count = resolveWorkerCount(
        {},
        34,
        platform,
        workers.defaultWidth,
        workers.windowsWidth
      );
      const groups = partitionByWeight(ownedFiles(lane), weights, count);
      const heaviest = [...listed]
        .sort(([, a], [, b]) => b - a)
        .slice(0, count)
        .map(([path]) => path);
      const holders = heaviest.map((path) => groups.findIndex((group) => group.includes(path)));

      expect(
        new Set(holders).size,
        `(${lane.id} split): expected the ${count} heaviest files on ${count} different workers | received workers: ${holders.join(', ')}`
      ).toBe(count);
    });
  }
);
