#!/usr/bin/env bun

// Enforce a lane's total-coverage floors against the artifacts its run just
// wrote. Chained after `bun test --coverage` in the lane's `test:coverage`
// script, so a miss fails the same invocation CI already watches.
//
// This exists because Bun 1.4.0's own `coverageThreshold` cannot express a
// total gate: it is enforced per *file* (every file must individually clear
// the bar, measured on both a fixture and the real suite), it goes silently
// inert under `coverageReporter = ["lcov"]` without `"text"`, and a miss
// prints nothing at all. Reading the LCOV back and comparing totals here
// avoids all three traps and adds the statement/branch figures Bun's reporter
// does not carry (derived from the sources by coverage-summary.ts).
//
// Usage: bun ./scripts/qa-gate/enforce-coverage-thresholds.ts <lane-id>

import type { WorkspaceName } from '../lib/config';
import { laneById, type TestLaneId } from '../lib/test-lanes';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import type { CoverageBucket } from './parse-lcov';

const [, , laneIdArg] = process.argv;
if (!laneIdArg) {
  process.stderr.write('Usage: bun ./scripts/qa-gate/enforce-coverage-thresholds.ts <lane-id>\n');
  process.exit(2);
}

const lane = laneById(laneIdArg as TestLaneId);
const thresholds = lane.coverageThresholds;
if (!thresholds || lane.workspace === 'root') {
  process.stderr.write(`Lane '${lane.id}' declares no coverage thresholds; nothing to enforce.\n`);
  process.exit(2);
}

const summary = await readWorkspaceCoverageSummary(lane.workspace as WorkspaceName);

const percent = (bucket: CoverageBucket | null): number | null =>
  bucket && bucket.total > 0 ? (bucket.covered / bucket.total) * 100 : null;

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
  process.stderr.write(
    `coverage ${lane.id} ${metric.padEnd(10)} ${value === null ? 'unreadable' : `${value.toFixed(2)}%`} ` +
      `(floor ${floor}%) ${miss ? 'FAIL' : 'ok'}\n`
  );
}

if (failed) {
  process.stderr.write(
    `Coverage for '${lane.id}' fell below its floors. A real drop means missing tests; ` +
      'a small dip on an unchanged suite is LCOV jitter — re-run before touching the floors in ' +
      'scripts/lib/test-lanes.ts.\n'
  );
  process.exit(1);
}
