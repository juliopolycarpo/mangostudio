// QA-gate metrics collector entrypoint. Assembles every metric (each failing
// independently via safe()) and writes the report as JSON to stdout.
// Collectors live in ./collect/*; shapes in ./collect/types.

import { ALL_WORKSPACE_NAMES } from '../lib/config';
import { collectFrontendBundle } from './collect/bundle';
import { countCircularDeps } from './collect/circular';
import { collectDependencyStats } from './collect/dependencies';
import { collectDuplication } from './collect/duplication';
import { measureLoc, sumLocBuckets } from './collect/loc';
import { getCommitSha, safe } from './collect/support';
import { collectTestLaneStats } from './collect/test-lanes';
import { collectToolingStats } from './collect/tooling';
import type { CoverageSummary, Failable, LocBucket, Metrics } from './collect/types';
import { countTsErrors } from './collect/typescript';
import { readWorkspaceCoverageSummary } from './coverage-summary';

const collectWorkspaceMetrics = async (): Promise<{
  loc: Record<string, Failable<LocBucket>>;
  coverage: Record<string, Failable<CoverageSummary>>;
  tsErrors: Record<string, Failable<number>>;
}> => {
  const loc: Record<string, Failable<LocBucket>> = {};
  const coverage: Record<string, Failable<CoverageSummary>> = {};
  const tsErrors: Record<string, Failable<number>> = {};

  for (const workspace of ALL_WORKSPACE_NAMES) {
    loc[workspace] = await safe(`loc:${workspace}`, () => measureLoc(`apps/${workspace}`));
    coverage[workspace] = await safe(`coverage:${workspace}`, () =>
      readWorkspaceCoverageSummary(workspace)
    );
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

const buildMetrics = async (): Promise<Metrics> => {
  const { loc, coverage, tsErrors } = await collectWorkspaceMetrics();
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
    tests: {
      unit: await safe('tests:unit', () => collectTestLaneStats('unit')),
      integration: await safe('tests:integration', () => collectTestLaneStats('integration')),
    },
    tooling: await safe('tooling', collectToolingStats),
  };
};

const metrics = await buildMetrics();
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
