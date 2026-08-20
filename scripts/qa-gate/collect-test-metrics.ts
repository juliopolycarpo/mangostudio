// Emits the test-derived QA metrics fragment after the sharded
// `bun run test --coverage` fan-out has been merged: per-workspace pass counts
// from each lane's JUnit report, the run's exit code and wall clock, Vitest's
// unhandled-error headlines, and the coverage summaries from
// `.mango/artifacts/coverage/`. collect.ts merges this fragment so the suite
// never runs twice for one report.
//
// JUnit reports are read from every shard directory *and* from the repository
// root: the Bun lanes write theirs inside the shard that ran them, while the
// frontend Vitest report only exists after `vitest --mergeReports` replays the
// blobs here in the merge job.
//
// Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir]

import { listShardDirs, type ShardSummary } from '../ci/merge-test-shards';
import { ALL_WORKSPACE_NAMES, ROOT_DIR } from '../lib/config';
import { safe } from './collect/support';
import type { CoverageSummary, Failable, TestMetricsFragment } from './collect/types';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { buildTestSuiteStats, readLaneResults } from './junit-results';
import type { VitestUnhandledErrors } from './vitest-unhandled-errors';

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
  vitestErrors: { errors: 0, headlines: [] },
};

// Parsing is not enough: `[]` is valid JSON and would hand an undefined exit
// code straight into the fragment, which renders as a suite with no outcome
// rather than a failed one. `{"exitCode":0}` is the same hole with a number
// in the one field the old guard checked.
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isVitestUnhandledErrors = (value: unknown): value is VitestUnhandledErrors =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  isFiniteNumber((value as VitestUnhandledErrors).errors) &&
  Array.isArray((value as VitestUnhandledErrors).headlines);

const isShardSummary = (value: unknown): value is ShardSummary => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<ShardSummary>;
  return (
    isFiniteNumber(summary.shards) &&
    isFiniteNumber(summary.exitCode) &&
    isFiniteNumber(summary.durationSeconds) &&
    (summary.vitestErrors === undefined || isVitestUnhandledErrors(summary.vitestErrors))
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
      vitestErrors: parsed.vitestErrors ?? FAILED_SUMMARY.vitestErrors,
    };
  } catch {
    return FAILED_SUMMARY;
  }
};

const summary = await readShardSummary(summaryPath);

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
    summary.vitestErrors,
    summary.exitCode,
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
