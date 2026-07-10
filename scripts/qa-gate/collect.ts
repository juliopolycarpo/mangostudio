// QA-gate metrics collector entrypoint. Assembles every metric (each failing
// independently via safe()) and writes the report as JSON to stdout.
// Collectors live in ./collect/*; shapes in ./collect/types.
//
// Test-derived metrics (suite outcome + coverage) come from the fragment the
// CI Test job writes via collect-test-metrics.ts (`--test-metrics <path>`), so
// the suite runs exactly once per report. Without the flag, coverage is read
// from local artifacts (dev convenience) and the suite outcome is marked as
// not collected.

import { ALL_WORKSPACE_NAMES } from '../lib/config';
import { collectFrontendBundle } from './collect/bundle';
import { countCircularDeps } from './collect/circular';
import { collectDependencyStats } from './collect/dependencies';
import { collectDuplication } from './collect/duplication';
import { measureLoc, sumLocBuckets } from './collect/loc';
import { getCommitSha, safe, stderrLog } from './collect/support';
import { collectToolingStats } from './collect/tooling';
import type {
  CoverageSummary,
  Failable,
  LocBucket,
  Metrics,
  TestMetricsFragment,
} from './collect/types';
import { countTsErrors } from './collect/typescript';
import { readWorkspaceCoverageSummary } from './coverage-summary';

const parseTestMetricsPath = (argv: readonly string[]): string | null => {
  const flagIndex = argv.indexOf('--test-metrics');
  if (flagIndex === -1) return null;
  const path = argv[flagIndex + 1];
  if (!path || path.startsWith('--')) {
    process.stderr.write('Usage: bun ./scripts/qa-gate/collect.ts [--test-metrics <path>]\n');
    process.exit(1);
  }
  return path;
};

const loadTestMetricsFragment = async (path: string): Promise<TestMetricsFragment | null> => {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'tests' in parsed &&
      'coverage' in parsed
    ) {
      return parsed as TestMetricsFragment;
    }
    stderrLog(`test metrics fragment ${path} lacks tests/coverage fields`);
  } catch (err) {
    stderrLog(`failed to load test metrics fragment ${path}: ${String(err)}`);
  }
  return null;
};

const collectWorkspaceMetrics = async (
  fragment: TestMetricsFragment | null
): Promise<{
  loc: Record<string, Failable<LocBucket>>;
  coverage: Record<string, Failable<CoverageSummary>>;
  tsErrors: Record<string, Failable<number>>;
}> => {
  const loc: Record<string, Failable<LocBucket>> = {};
  const coverage: Record<string, Failable<CoverageSummary>> = {};
  const tsErrors: Record<string, Failable<number>> = {};

  for (const workspace of ALL_WORKSPACE_NAMES) {
    loc[workspace] = await safe(`loc:${workspace}`, () => measureLoc(`apps/${workspace}`));
    coverage[workspace] =
      fragment?.coverage[workspace] ??
      (await safe(`coverage:${workspace}`, () => readWorkspaceCoverageSummary(workspace)));
    tsErrors[workspace] = await safe(`ts:${workspace}`, () => countTsErrors(workspace));
  }

  return { loc, coverage, tsErrors };
};

const totalLoc = (loc: Record<string, Failable<LocBucket>>): Failable<LocBucket> => {
  const valid = ALL_WORKSPACE_NAMES.map((workspace) => loc[workspace]).filter(
    (value): value is LocBucket => !('error' in value)
  );
  return valid.length === 0 ? { error: 'no workspace LoC available' } : sumLocBuckets(valid);
};

const buildMetrics = async (fragment: TestMetricsFragment | null): Promise<Metrics> => {
  const { loc, coverage, tsErrors } = await collectWorkspaceMetrics(fragment);
  loc.total = totalLoc(loc);

  return {
    sha: getCommitSha(),
    generatedAt: new Date().toISOString(),
    loc: loc as Metrics['loc'],
    coverage: coverage as Metrics['coverage'],
    tsErrors: tsErrors as Metrics['tsErrors'],
    duplication: await safe('duplication', collectDuplication),
    circularDeps: await safe('circularDeps', countCircularDeps),
    frontendBundle: await safe('frontendBundle', collectFrontendBundle),
    dependencies: await safe('dependencies', collectDependencyStats),
    tests: fragment?.tests ?? { error: 'test metrics fragment not provided' },
    tooling: await safe('tooling', collectToolingStats),
  };
};

const testMetricsPath = parseTestMetricsPath(process.argv.slice(2));
const fragment = testMetricsPath ? await loadTestMetricsFragment(testMetricsPath) : null;
const metrics = await buildMetrics(fragment);
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
