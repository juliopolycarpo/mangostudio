#!/usr/bin/env bun

// Enforce a lane's total-coverage floors against the artifacts its run just
// wrote. Chained after `bun test --coverage` in the lane's `test:coverage`
// script, so a miss fails the same invocation CI already watches.
//
// This exists because Bun's own `coverageThreshold` cannot express a total
// gate: it is enforced per *file* (every file must individually clear the bar,
// measured on 1.4.0 on both a fixture and the real suite, re-verified on a
// fixture on 1.4.2; oven-sh/bun#17028), and a miss prints nothing at all.
// Reading the LCOV back and comparing totals here avoids both traps and adds
// the statement/branch figures Bun's reporter does not carry (derived from the
// sources by coverage-summary.ts).
//
// The LCOV itself is checked before it is trusted: a missing report, or one
// that is empty or cut off mid-record, fails naming the file. Without that a
// truncated report parses as a smaller, complete-looking one and is enforced
// against the floors as if it were the whole run.
//
// Usage: bun ./scripts/qa-gate/enforce-coverage-thresholds.ts <lane-id>

import { join } from 'node:path';

import { ROOT_DIR, type WorkspaceName } from '../lib/config';
import { laneById, SHARDED_LCOV_PATHS, type TestLaneId } from '../lib/test-lanes';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { findLcovProblem } from './merge-lcov-shards';
import type { CoverageBucket, CoverageSummary } from './parse-lcov';

/** Everything the enforcement reads or writes, so a test can run it without a checkout. */
export interface EnforceDeps {
  /** Text of a repo-relative file, or null when it does not exist. */
  readonly readText: (repoRelativePath: string) => Promise<string | null>;
  readonly readSummary: (workspace: WorkspaceName) => Promise<CoverageSummary>;
  readonly write: (text: string) => void;
}

const percent = (bucket: CoverageBucket | null): number | null =>
  bucket && bucket.total > 0 ? (bucket.covered / bucket.total) * 100 : null;

/** Why the workspace's LCOV cannot be enforced against, or null when it is usable. */
const lcovProblem = async (lcovPath: string, deps: EnforceDeps): Promise<string | null> => {
  const text = await deps.readText(lcovPath);
  if (text === null) return `LCOV report missing at ${lcovPath}; the lane wrote none`;
  const problem = findLcovProblem(text);
  return problem === null ? null : `LCOV report at ${lcovPath} is unusable: ${problem}`;
};

/**
 * Enforce a lane's coverage floors. Returns the process exit code: 0 when every
 * floor holds, 1 for a miss or an unusable report, 2 for a lane with nothing to
 * enforce.
 * // Usage: process.exit(await enforceCoverageThresholds('frontend', realDeps));
 */
export const enforceCoverageThresholds = async (
  laneIdArg: string | undefined,
  deps: EnforceDeps
): Promise<number> => {
  if (!laneIdArg) {
    deps.write('Usage: bun ./scripts/qa-gate/enforce-coverage-thresholds.ts <lane-id>\n');
    return 2;
  }

  const lane = laneById(laneIdArg as TestLaneId);
  const thresholds = lane.coverageThresholds;
  if (!thresholds || lane.workspace === 'root') {
    deps.write(`Lane '${lane.id}' declares no coverage thresholds; nothing to enforce.\n`);
    return 2;
  }

  const workspace = lane.workspace as WorkspaceName;
  const lcovPath = SHARDED_LCOV_PATHS[workspace];
  const problem = lcovPath ? await lcovProblem(lcovPath, deps) : null;
  if (problem) {
    deps.write(`coverage ${lane.id}: ${problem}. Cannot enforce floors against it.\n`);
    return 1;
  }

  const summary = await deps.readSummary(workspace);
  const measured: Readonly<Record<keyof typeof thresholds, number | null>> = {
    lines: percent(summary.lines),
    functions: percent(summary.functions),
    statements: percent(summary.statements),
    branches: percent(summary.branches),
  };

  let failed = false;
  for (const [metric, floor] of Object.entries(thresholds)) {
    const value = measured[metric as keyof typeof measured];
    // A metric that could not be computed is a broken pipeline, not 0% coverage
    // — fail rather than letting a parse regression read as a passing gate.
    const miss = value === null || value < floor;
    if (miss) failed = true;
    deps.write(
      `coverage ${lane.id} ${metric.padEnd(10)} ${value === null ? 'unreadable' : `${value.toFixed(2)}%`} ` +
        `(floor ${floor}%) ${miss ? 'FAIL' : 'ok'}\n`
    );
  }

  if (failed) {
    deps.write(
      `Coverage for '${lane.id}' fell below its floors. A real drop means missing tests; ` +
        'a small dip on an unchanged suite is LCOV jitter — re-run before touching the floors in ' +
        'scripts/lib/test-lanes.ts.\n'
    );
    return 1;
  }
  return 0;
};

if (import.meta.main) {
  const exitCode = await enforceCoverageThresholds(process.argv[2], {
    readText: async (path) => {
      const file = Bun.file(join(ROOT_DIR, path));
      return (await file.exists()) ? file.text() : null;
    },
    readSummary: readWorkspaceCoverageSummary,
    write: (text) => {
      process.stderr.write(text);
    },
  });
  process.exit(exitCode);
}
