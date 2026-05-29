// Coverage comparison table (per workspace × metric).

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../../lib/config';
import type { Metrics } from '../collect/types';
import { COVERAGE_KEYS, type CoverageKey, getCoverageBucket } from './access';
import { formatNumber, formatPct, NA, renderDelta } from './format';

const renderCoverageRow = (
  base: Metrics | null,
  head: Metrics | null,
  workspace: WorkspaceName,
  key: CoverageKey
): string => {
  const baseBucket = getCoverageBucket(base?.coverage?.[workspace], key);
  const headBucket = getCoverageBucket(head?.coverage?.[workspace], key);
  const baseCell = baseBucket
    ? `${formatPct(baseBucket.pct)} (${formatNumber(baseBucket.covered)}/${formatNumber(baseBucket.total)})`
    : NA;
  const headCell = headBucket
    ? `${formatPct(headBucket.pct)} (${formatNumber(headBucket.covered)}/${formatNumber(headBucket.total)})`
    : NA;
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
    '_API/shared branches and statements are source-derived from LCOV line hits because Bun LCOV does not emit branch or statement records._',
    '',
    '| Workspace | Metric | Base | Head | Δ |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};
