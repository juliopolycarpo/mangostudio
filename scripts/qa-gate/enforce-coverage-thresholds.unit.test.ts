import { describe, expect, it } from 'bun:test';

import { laneById, SHARDED_LCOV_PATHS } from '../lib/test-lanes';
import { type EnforceDeps, enforceCoverageThresholds } from './enforce-coverage-thresholds';
import { type CoverageSummary, coverageBucket } from './parse-lcov';

const COMPLETE_LCOV = 'TN:\nSF:src/a.ts\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
const FRONTEND_LCOV = SHARDED_LCOV_PATHS.frontend as string;

const floors = laneById('frontend').coverageThresholds;
if (!floors) throw new Error('expected the frontend lane to declare coverage thresholds');

/** A summary whose four dimensions sit `margin` points away from the frontend floors. */
const summaryAt = (margin: number): CoverageSummary => {
  const bucket = (floor: number) => coverageBucket(1000, Math.round((floor + margin) * 10));
  return {
    lines: bucket(floors.lines),
    functions: bucket(floors.functions),
    statements: bucket(floors.statements),
    branches: bucket(floors.branches),
  };
};

interface FakeRun {
  readonly deps: EnforceDeps;
  readonly output: string[];
  readonly summaryReads: number[];
}

/** In-memory stand-in for the checkout: `files` maps repo-relative paths to text. */
const fakeDeps = (files: Record<string, string>, summary: CoverageSummary): FakeRun => {
  const output: string[] = [];
  const summaryReads: number[] = [];
  const deps: EnforceDeps = {
    readText: (path) => Promise.resolve(files[path] ?? null),
    readSummary: () => {
      summaryReads.push(1);
      return Promise.resolve(summary);
    },
    write: (text) => {
      output.push(text);
    },
  };
  return { deps, output, summaryReads };
};

describe('enforceCoverageThresholds', () => {
  it('passes when every dimension clears its floor', async () => {
    const { deps, output } = fakeDeps({ [FRONTEND_LCOV]: COMPLETE_LCOV }, summaryAt(1));

    expect(await enforceCoverageThresholds('frontend', deps)).toBe(0);
    expect(output.join('')).not.toContain('FAIL');
  });

  it('fails a dimension below its floor and says which', async () => {
    const { deps, output } = fakeDeps({ [FRONTEND_LCOV]: COMPLETE_LCOV }, summaryAt(-1));

    expect(await enforceCoverageThresholds('frontend', deps)).toBe(1);
    expect(output.join('')).toContain(`lines      ${(floors.lines - 1).toFixed(2)}%`);
    expect(output.join('')).toContain('FAIL');
  });

  it('fails a dimension that could not be computed instead of reading it as passing', async () => {
    const summary: CoverageSummary = { ...summaryAt(1), branches: null };
    const { deps, output } = fakeDeps({ [FRONTEND_LCOV]: COMPLETE_LCOV }, summary);

    expect(await enforceCoverageThresholds('frontend', deps)).toBe(1);
    expect(output.join('')).toContain('branches   unreadable');
  });

  it('fails a missing report by name without reading a summary', async () => {
    const { deps, output, summaryReads } = fakeDeps({}, summaryAt(1));

    expect(await enforceCoverageThresholds('frontend', deps)).toBe(1);
    expect(output.join('')).toContain(`LCOV report missing at ${FRONTEND_LCOV}`);
    expect(summaryReads).toEqual([]);
  });

  it('fails a truncated report by name rather than enforcing the floors against it', async () => {
    const truncated = COMPLETE_LCOV.replace('end_of_record\n', '');
    const { deps, output, summaryReads } = fakeDeps({ [FRONTEND_LCOV]: truncated }, summaryAt(5));

    expect(await enforceCoverageThresholds('frontend', deps)).toBe(1);
    expect(output.join('')).toContain(
      `LCOV report at ${FRONTEND_LCOV} is unusable: truncated: record for src/a.ts has no end_of_record`
    );
    expect(summaryReads).toEqual([]);
  });

  it('fails an empty report by name', async () => {
    const { deps, output } = fakeDeps({ [FRONTEND_LCOV]: '' }, summaryAt(5));

    expect(await enforceCoverageThresholds('frontend', deps)).toBe(1);
    expect(output.join('')).toContain('is unusable: report is empty');
  });

  it('exits 2 for a lane with no thresholds', async () => {
    const { deps, output } = fakeDeps({}, summaryAt(1));

    expect(await enforceCoverageThresholds('root', deps)).toBe(2);
    expect(output.join('')).toContain("Lane 'root' declares no coverage thresholds");
  });

  it('exits 2 with usage when no lane is given', async () => {
    const { deps, output } = fakeDeps({}, summaryAt(1));

    expect(await enforceCoverageThresholds(undefined, deps)).toBe(2);
    expect(output.join('')).toContain('Usage:');
  });
});
