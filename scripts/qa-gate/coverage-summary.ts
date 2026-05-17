import { join } from 'node:path';

import { ALL_WORKSPACE_NAMES, ROOT_DIR, type WorkspaceName } from '../lib/config';
import { type CoverageBucket, type CoverageSummary, parseLcovSummary } from './parse-lcov';

export type CoverageSourceKind = 'json-summary' | 'lcov';

export interface CoverageSource {
  readonly kind: CoverageSourceKind;
  readonly file: string;
}

interface JsonCoverageSummaryShape {
  readonly total?: {
    readonly lines: CoverageBucket;
    readonly statements: CoverageBucket;
    readonly functions: CoverageBucket;
    readonly branches: CoverageBucket;
  };
}

export const WORKSPACE_COVERAGE_SOURCES: Readonly<
  Record<WorkspaceName, readonly CoverageSource[]>
> = {
  frontend: [
    { kind: 'json-summary', file: 'apps/frontend/coverage/coverage-summary.json' },
    { kind: 'lcov', file: 'apps/frontend/coverage/bun/lcov.info' },
  ],
  api: [{ kind: 'lcov', file: 'apps/api/coverage/lcov.info' }],
  shared: [{ kind: 'lcov', file: 'apps/shared/coverage/lcov.info' }],
};

export const readJsonCoverageSummary = async (absPath: string): Promise<CoverageSummary> => {
  const text = await Bun.file(absPath).text();
  const json = JSON.parse(text) as JsonCoverageSummaryShape;
  if (!json.total) throw new Error(`Missing 'total' in ${absPath}`);
  const total = json.total;
  return {
    lines: total.lines,
    statements: total.statements,
    functions: total.functions,
    branches: total.branches,
  };
};

const sumBuckets = (buckets: readonly CoverageBucket[]): CoverageBucket => {
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const covered = buckets.reduce((sum, bucket) => sum + bucket.covered, 0);
  return {
    total,
    covered,
    pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
  };
};

const sumOptionalBuckets = (
  summaries: readonly CoverageSummary[],
  selector: (summary: CoverageSummary) => CoverageBucket | null
): CoverageBucket | null => {
  const buckets = summaries.map(selector).filter((bucket): bucket is CoverageBucket => !!bucket);
  return buckets.length === 0 ? null : sumBuckets(buckets);
};

export const mergeCoverageSummaries = (summaries: readonly CoverageSummary[]): CoverageSummary => {
  if (summaries.length === 0) {
    throw new Error('Cannot merge an empty coverage summary list.');
  }

  return {
    lines: sumBuckets(summaries.map((summary) => summary.lines)),
    functions: sumBuckets(summaries.map((summary) => summary.functions)),
    statements: sumOptionalBuckets(summaries, (summary) => summary.statements),
    branches: sumOptionalBuckets(summaries, (summary) => summary.branches),
  };
};

export const readCoverageSource = (source: CoverageSource): Promise<CoverageSummary> => {
  const absPath = join(ROOT_DIR, source.file);
  return source.kind === 'json-summary'
    ? readJsonCoverageSummary(absPath)
    : parseLcovSummary(absPath);
};

export const readWorkspaceCoverageSummary = async (
  workspace: WorkspaceName
): Promise<CoverageSummary> => {
  const summaries = await Promise.all(
    WORKSPACE_COVERAGE_SOURCES[workspace].map(readCoverageSource)
  );
  return mergeCoverageSummaries(summaries);
};

export const coverageWorkspaceNames = (): readonly WorkspaceName[] => ALL_WORKSPACE_NAMES;
