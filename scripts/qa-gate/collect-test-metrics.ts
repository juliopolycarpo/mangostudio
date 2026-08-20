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

const [, , summaryPath, shardsRoot] = process.argv;
if (!summaryPath) {
  process.stderr.write(
    'Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <shard-summary.json> [shards-dir]\n'
  );
  process.exit(1);
}

const summaryFile = Bun.file(summaryPath);
const summary: ShardSummary = (await summaryFile.exists())
  ? ((await summaryFile.json()) as ShardSummary)
  : { shards: 0, exitCode: 1, durationSeconds: 0, vitestErrors: { errors: 0, headlines: [] } };

const junitDirs = [ROOT_DIR, ...(shardsRoot ? await listShardDirs(shardsRoot) : [])];

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
