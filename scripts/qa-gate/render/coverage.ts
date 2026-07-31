// Coverage comparison table (per workspace × metric).

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../../lib/config';
import type { Metrics } from '../collect/types';
import type { CoverageBucket } from '../parse-lcov';
import { COVERAGE_KEYS, type CoverageKey, getCoverageBucket } from './access';
import { formatNumber, formatPct, NA, renderDelta } from './format';

// A bucket with a null pct is a legitimate 0/0 ("n/a (0/0)"), distinct from a
// missing bucket (bare "n/a"), which means the collector failed or the metric
// does not exist for that workspace.
const renderCoverageCell = (bucket: CoverageBucket | null): string => {
  if (!bucket) return NA;
  const pct = bucket.pct === null ? NA : formatPct(bucket.pct);
  return `${pct} (${formatNumber(bucket.covered)}/${formatNumber(bucket.total)})`;
};

const renderCoverageRow = (
  base: Metrics | null,
  head: Metrics | null,
  workspace: WorkspaceName,
  key: CoverageKey
): string => {
  const baseBucket = getCoverageBucket(base?.coverage?.[workspace], key);
  const headBucket = getCoverageBucket(head?.coverage?.[workspace], key);
  const baseCell = renderCoverageCell(baseBucket);
  const headCell = renderCoverageCell(headBucket);
  const delta = renderDelta(baseBucket?.pct ?? null, headBucket?.pct ?? null, {
    higherIsBetter: true,
    suffix: 'pp',
  });
  return `| ${workspace} | ${key} | ${baseCell} | ${headCell} | ${delta} |`;
};

export const renderCoverageSection = (base: Metrics | null, head: Metrics | null): string => {
  const rows: string[] = [];
  for (const workspace of ALL_WORKSPACE_NAMES) {
    for (const key of COVERAGE_KEYS) {
      rows.push(renderCoverageRow(base, head, workspace, key));
    }
  }
  return [
    '### Coverage',
    '',
    '_API/shared/runtime branches and statements are source-derived from LCOV line hits because Bun LCOV does not emit branch or statement records._',
    '',
    '| Workspace | Metric | Base | Head | Δ |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};
