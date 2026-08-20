// Emits the test-derived QA metrics fragment after the sharded
// `bun run test --coverage` fan-out has been merged: per-workspace pass counts
// from each lane's JUnit report, the run's exit code and wall clock, the
// unhandled-error headlines JUnit cannot carry, and the coverage summaries from
// `.mango/artifacts/coverage/`. collect.ts merges this fragment so the suite
// never runs twice for one report.
//
// JUnit reports are read from every shard directory *and* from the repository
// root: the Bun lanes write theirs inside the shard that ran them, while the
// frontend Vitest report only exists after `vitest --mergeReports` replays the
// blobs here in the merge job.
//
// The optional third argument is the merge job's coverage-threshold gate exit
// code. The shard summary only knows how the shards themselves ended, and the
// frontend thresholds now run after them; without this a coverage-only failure
// would report `exitCode: 0` and render a passing verdict on a red run.
//
// Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir] [gate-exit-code]

import { listShardDirs, type ShardSummary } from '../ci/merge-test-shards';
import { ALL_WORKSPACE_NAMES, ROOT_DIR } from '../lib/config';
import { safe } from './collect/support';
import type { CoverageSummary, Failable, TestMetricsFragment } from './collect/types';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { buildTestSuiteStats, readLaneResults } from './junit-results';
import type { UnhandledErrors } from './unhandled-errors';

const [, , summaryPath, shardsRoot, gateExitCodeArg] = process.argv;
if (!summaryPath) {
  process.stderr.write(
    'Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir] [gate-exit-code]\n'
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

// A missing or unparseable value is treated as a failed gate: this argument
// only ever comes from a step outcome, and "unknown" there means the step did
// not report success.
const gateExitCode = ((): number => {
  if (gateExitCodeArg === undefined) return 0;
  if (gateExitCodeArg.trim() === '') return 1;
  const parsed = Number(gateExitCodeArg);
  return Number.isInteger(parsed) ? parsed : 1;
})();
const exitCode = summary.exitCode !== 0 ? summary.exitCode : gateExitCode;

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
