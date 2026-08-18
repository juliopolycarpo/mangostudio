// Emits the test-derived QA metrics fragment right after the authoritative
// `bun run test --coverage` pass: per-workspace pass counts and failure
// signals parsed from the runner log, the pass exit code and duration, and
// the coverage summaries from `.mango/artifacts/coverage/`. collect.ts merges
// this fragment so the suite never runs twice for one report.
// Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <coverage-log> <exit-code> <duration-seconds>

import { ALL_WORKSPACE_NAMES } from '../lib/config';
import { safe } from './collect/support';
import type { CoverageSummary, Failable, TestMetricsFragment } from './collect/types';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import { buildTestSuiteStats } from './test-result-counts';

const [, , logPath, exitCodeArg, durationArg] = process.argv;
if (!logPath) {
  process.stderr.write(
    'Usage: bun ./scripts/qa-gate/collect-test-metrics.ts <coverage-log> <exit-code> <duration-seconds>\n'
  );
  process.exit(1);
}

const parseOptionalInt = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
};

const collectSuiteStats = async () =>
  buildTestSuiteStats(
    await Bun.file(logPath).text(),
    parseOptionalInt(exitCodeArg),
    parseOptionalInt(durationArg)
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
