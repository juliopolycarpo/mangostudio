// Emits the test-derived QA metrics fragment after the sharded
// `bun run test --coverage` fan-out has been merged: per-workspace pass counts
// from each lane's JUnit report, the run's exit code and wall clock, the
// unhandled-error headlines JUnit cannot carry, and the coverage summaries from
// `.mango/artifacts/coverage/`. collect.ts merges this fragment so the suite
// never runs twice for one report.
//
// JUnit reports are read from every test-job directory *and* from the
// repository root: on CI every lane writes inside the job that ran it (the
// frontend's whole-suite report arrives via its own `test-shard-frontend`
// artifact), while a local unsharded run writes straight into the checkout.
//
// The frontend coverage thresholds need no separate plumbing here: they are
// enforced inside the lane's own `test:coverage` invocation
// (enforce-coverage-thresholds.ts), so a miss is already a non-zero exit code
// in that job's shard-meta.
//
// Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir]

import { listShardDirs, type ShardSummary } from '../ci/merge-test-shards';
import { ALL_WORKSPACE_NAMES, ROOT_DIR } from '../lib/config';
import { safe } from './collect/support';
import type { CoverageSummary, Failable, TestMetricsFragment } from './collect/types';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { buildTestSuiteStats, readLaneResults } from './junit-results';
import type { UnhandledErrors } from './unhandled-errors';

const [, , summaryPath, shardsRoot] = process.argv;
if (!summaryPath) {
  process.stderr.write(
    'Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir]\n'
  );
  process.exit(1);
}

// A shard summary that is missing, empty, or truncated means the merge step
// failed before writing it — which is exactly when the QA report most needs to
// render. Degrade to a failing exit code rather than throwing: this step runs
// under `if: !cancelled()` precisely so a broken merge still produces a
// fragment, and an unhandled parse error here would defeat that.
const FAILED_SUMMARY: ShardSummary = {
  shards: 0,
  exitCode: 1,
  durationSeconds: 0,
  unhandledErrors: { errors: 0, headlines: [] },
};

// Parsing is not enough: `[]` is valid JSON and would hand an undefined exit
// code straight into the fragment, which renders as a suite with no outcome
// rather than a failed one. `{"exitCode":0}` is the same hole with a number
// in the one field the old guard checked.
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isUnhandledErrors = (value: unknown): value is UnhandledErrors =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  isFiniteNumber((value as UnhandledErrors).errors) &&
  Array.isArray((value as UnhandledErrors).headlines);

const isShardSummary = (value: unknown): value is ShardSummary => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<ShardSummary>;
  return (
    isFiniteNumber(summary.shards) &&
    isFiniteNumber(summary.exitCode) &&
    isFiniteNumber(summary.durationSeconds) &&
    (summary.unhandledErrors === undefined || isUnhandledErrors(summary.unhandledErrors))
  );
};

const readShardSummary = async (path: string): Promise<ShardSummary> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return FAILED_SUMMARY;
  try {
    const parsed: unknown = await file.json();
    if (!isShardSummary(parsed)) return FAILED_SUMMARY;
    return {
      ...parsed,
      unhandledErrors: parsed.unhandledErrors ?? FAILED_SUMMARY.unhandledErrors,
    };
  } catch {
    return FAILED_SUMMARY;
  }
};

const summary = await readShardSummary(summaryPath);
const exitCode = summary.exitCode;

const listShards = async (root: string): Promise<readonly string[]> => {
  try {
    return await listShardDirs(root);
  } catch {
    return [];
  }
};

const junitDirs = [ROOT_DIR, ...(shardsRoot ? await listShards(shardsRoot) : [])];

const collectSuiteStats = async () =>
  buildTestSuiteStats(
    await readLaneResults(junitDirs),
    summary.unhandledErrors,
    exitCode,
    summary.durationSeconds
  );

const coverage: Record<string, Failable<CoverageSummary>> = {};
for (const workspace of ALL_WORKSPACE_NAMES) {
  coverage[workspace] = await safe(`coverage:${workspace}`, () =>
    readWorkspaceCoverageSummary(workspace)
  );
}

const fragment: TestMetricsFragment = {
  tests: await safe('tests', collectSuiteStats),
  coverage: coverage as TestMetricsFragment['coverage'],
};

process.stdout.write(`${JSON.stringify(fragment, null, 2)}\n`);
