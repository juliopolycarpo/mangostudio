// Emits the test-derived QA metrics fragment after the sharded
// `bun run test --coverage` fan-out has been merged: per-workspace pass counts
// from each lane's JUnit report, the run's exit code and wall clock, the
// unhandled-error headlines JUnit cannot carry, and the coverage summaries from
// `.mango/artifacts/coverage/`. collect.ts merges this fragment so the suite
// never runs twice for one report.
//
// JUnit reports and process receipts (`shard-meta.json`) are read from the jobs
// the lane registry says a complete run has: the numbered shards (count from the
// workflow) plus one job per unsharded lane. A job that never uploaded, a
// missing or cut-off report and a missing receipt each make the affected lanes
// `partial`; see ./results/fold.ts. With no shards directory (a local unsharded
// run) the checkout itself is the single job.
//
// The frontend coverage thresholds need no separate plumbing here: they are
// enforced inside the lane's own `test:coverage` invocation
// (enforce-coverage-thresholds.ts), so a miss is already a non-zero exit code
// in that job's shard-meta.
//
// Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir [shard-count]]

import { basename } from 'node:path';

import { listShardDirs, type ShardSummary } from '../ci/merge-test-shards';
import { ALL_WORKSPACE_NAMES, ROOT_DIR } from '../lib/config';
import { isReceiptDuration, isReceiptExitCode } from '../lib/shard-receipt';
import { TEST_LANES } from '../lib/test-lanes';
import { resolveSourceSha } from './collect/provenance';
import { getCommitSha, measure } from './collect/support';
import type {
  CoverageSummary,
  Measurement,
  TestMetricsFragment,
  TestSuiteStats,
} from './collect/types';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { buildTestSuiteStats, type LaneOutcome } from './junit-results';
import { unavailable } from './model/states';
import { collectLaneOutcomes, laneCells, suiteMeasurement } from './results/collect';
import { readTextOrNull } from './results/evidence';
import { type ExpectedJobSet, expectedLocalJobs, expectedShardJobs } from './results/expected-jobs';
import { isUnhandledErrors } from './unhandled-errors';

const [, , summaryPath, shardsRoot, shardCountArg] = process.argv;
if (!summaryPath) {
  process.stderr.write(
    'Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir [shard-count]]\n'
  );
  process.exit(1);
}

// A shard summary that is missing, empty, or truncated means the merge step
// failed before writing it — which is exactly when the QA report most needs to
// render. Degrade to a failing exit code rather than throwing: this step runs
// under `if: !cancelled()` precisely so a broken merge still produces a
// fragment, and an unhandled parse error here would defeat that.
const failedSummary = (path: string, received: string): ShardSummary => ({
  shards: 0,
  exitCode: 1,
  durationSeconds: null,
  // Nothing was read, so the count is unknown: the zero here is a placeholder
  // and `unhandledErrorsUnavailable` is what keeps it from reading as measured.
  unhandledErrors: { errors: 0, headlines: [] },
  unhandledErrorsUnavailable: {
    'shard-summary': `${path}: expected a shard summary object | received: ${received}`,
  },
});

// Parsing is not enough: `[]` is valid JSON and would hand an undefined exit
// code straight into the fragment, which renders as a suite with no outcome
// rather than a failed one. `{"exitCode":0}` is the same hole with a number
// in the one field the old guard checked.

// One reason string per key; anything else is a summary the merge did not write.
const isReasonMap = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((reason) => typeof reason === 'string' && reason.length > 0);

const isShardSummary = (value: unknown): value is ShardSummary => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<ShardSummary>;
  return (
    Number.isSafeInteger(summary.shards) &&
    (summary.shards ?? -1) >= 0 &&
    isReceiptExitCode(summary.exitCode) &&
    (summary.durationSeconds === null || isReceiptDuration(summary.durationSeconds)) &&
    (summary.unhandledErrors === undefined || isUnhandledErrors(summary.unhandledErrors)) &&
    (summary.unhandledErrorsUnavailable === undefined ||
      isReasonMap(summary.unhandledErrorsUnavailable)) &&
    (summary.coverageErrors === undefined || isReasonMap(summary.coverageErrors))
  );
};

const readShardSummary = async (path: string): Promise<ShardSummary> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return failedSummary(path, 'no such file');
  try {
    const parsed: unknown = await file.json();
    if (!isShardSummary(parsed)) {
      return failedSummary(path, JSON.stringify(parsed)?.slice(0, 80) ?? String(parsed));
    }
    // A summary with no `unhandledErrors` at all never read the shards' counts.
    return parsed.unhandledErrors === undefined
      ? {
          ...parsed,
          unhandledErrors: { errors: 0, headlines: [] },
          unhandledErrorsUnavailable: {
            ...parsed.unhandledErrorsUnavailable,
            'shard-summary': `${path}: expected an "unhandledErrors" object | received: none`,
          },
        }
      : parsed;
  } catch {
    return failedSummary(path, 'invalid JSON');
  }
};

// Absent means "not stated" (a local run, or a caller that predates the count):
// the shard set is then unverified rather than assumed complete.
const parseShardCount = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const count = Number(raw);
  if (Number.isInteger(count) && count >= 1) return count;
  process.stderr.write(
    `Invalid shard count ${JSON.stringify(raw)}; expected a positive integer.\n`
  );
  process.exit(1);
};

const shardCount = parseShardCount(shardCountArg);
const summary = await readShardSummary(summaryPath);
const exitCode = summary.exitCode;

const listShards = async (root: string): Promise<readonly string[]> => {
  try {
    return await listShardDirs(root);
  } catch {
    return [];
  }
};

// The expected job set comes from the lane registry plus the workflow's shard
// count, never from the directories found: a job that died before its upload
// step leaves no directory, and listing what exists would add up to a smaller,
// complete-looking total. Without a shards directory this is a single-machine
// run whose one job's receipt is the summary itself.
const expectedJobSet = async (): Promise<ExpectedJobSet> => {
  if (!shardsRoot) return expectedLocalJobs(ROOT_DIR);
  const present = (await listShards(shardsRoot)).map((dir) => basename(dir));
  return expectedShardJobs(shardsRoot, shardCount, present);
};

const collectSuite = async (): Promise<{
  readonly outcomes: readonly LaneOutcome[];
  readonly suite: Measurement<TestSuiteStats>;
}> => {
  const outcomes = await collectLaneOutcomes({
    jobSet: await expectedJobSet(),
    lanes: TEST_LANES,
    readText: readTextOrNull,
    receiptOverride: shardsRoot ? undefined : { kind: 'read', exitCode },
  });
  const stats = buildTestSuiteStats(
    outcomes,
    summary.unhandledErrors,
    exitCode,
    summary.durationSeconds
  );
  // A shard whose unhandled-error count is unknown makes `errors` a lower bound.
  const unknownCounts = Object.entries(summary.unhandledErrorsUnavailable ?? {}).map(
    ([shard, reason]) => `unhandled-error count unknown (${shard}): ${reason}`
  );
  return { outcomes, suite: suiteMeasurement(stats, outcomes, unknownCounts) };
};

// A workspace the shard merge could not assemble is unavailable with the
// merge's reason (which names the shard), not read from whatever file is left.
const coverage: Record<string, Measurement<CoverageSummary>> = {};
for (const workspace of ALL_WORKSPACE_NAMES) {
  const mergeFailure = summary.coverageErrors?.[workspace];
  coverage[workspace] = mergeFailure
    ? unavailable(mergeFailure)
    : await measure(`coverage:${workspace}`, () => readWorkspaceCoverageSummary(workspace));
}

const collected = await measure('tests', collectSuite);
// A collector failure leaves no lane result to trust: every lane is unavailable.
const collectionFailure = unavailable<never>(
  collected.state === 'measured' ? 'lane collection did not run' : collected.reasons
);

const fragment: TestMetricsFragment = {
  // The commit this job measured, so the collector can tell a fragment from
  // another commit (stale) from one that never arrived.
  sourceSha: resolveSourceSha(process.env, getCommitSha()),
  tests: collected.state === 'measured' ? collected.value.suite : collectionFailure,
  lanes:
    collected.state === 'measured'
      ? laneCells(collected.value.outcomes)
      : Object.fromEntries(TEST_LANES.map((lane) => [lane.id, collectionFailure])),
  coverage,
};

process.stdout.write(`${JSON.stringify(fragment, null, 2)}\n`);
