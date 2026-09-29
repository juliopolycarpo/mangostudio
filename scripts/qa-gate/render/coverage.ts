// Coverage comparison table (per component × metric). Components with no
// coverage lane (`unsupported` on both sides) get no rows: they have nothing
// to compare, and the section would otherwise be mostly n/a.

import type { Metrics } from '../collect/types';
import type { CoverageBucket } from '../parse-lcov';
import {
  type CoverageKey,
  componentLabel,
  componentRows,
  coverageKeysFor,
  findComponent,
  getCoverageBucket,
} from './access';
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
  id: string,
  label: string,
  key: CoverageKey
): string => {
  const baseBucket = getCoverageBucket(findComponent(base, id)?.coverage, key);
  const headBucket = getCoverageBucket(findComponent(head, id)?.coverage, key);
  const baseCell = renderCoverageCell(baseBucket);
  const headCell = renderCoverageCell(headBucket);
  const delta = renderDelta(baseBucket?.pct ?? null, headBucket?.pct ?? null, {
    higherIsBetter: true,
    suffix: 'pp',
  });
  return `| ${label} | ${key} | ${baseCell} | ${headCell} | ${delta} |`;
};

export const renderCoverageSection = (base: Metrics | null, head: Metrics | null): string => {
  const rows: string[] = [];
  for (const component of componentRows(base, head)) {
    const onLane = [findComponent(base, component.id), findComponent(head, component.id)].some(
      (side) => side !== null && side.coverage.state !== 'unsupported'
    );
    if (!onLane) continue;
    for (const key of coverageKeysFor(component.kind)) {
      rows.push(renderCoverageRow(base, head, component.id, componentLabel(component), key));
    }
  }
  return [
    '### Coverage',
    '',
    '_API/shared branches and statements are source-derived from LCOV line hits because Bun LCOV does not emit branch or statement records._',
    '',
    '_Rust crates: line, function and region coverage from `cargo llvm-cov` over the ubuntu libtest run. Branch coverage is not collected and doctests are not instrumented. A crate shows n/a when the Rust lane did not run for the change or its profile data is incomplete._',
    '',
    '| Component | Metric | Base | Head | Δ |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};
