// Coverage comparison table (per component × metric). Components with no
// coverage lane (`unsupported` on both sides) get no rows: they have nothing
// to compare, and the section would otherwise be mostly n/a.

import type { ComponentKind, Metrics } from '../collect/types';
import type { CoverageBucket } from '../parse-lcov';
import {
  type CoverageKey,
  componentLabel,
  componentRows,
  coverageKeysFor,
  findComponent,
  getCoverageBucket,
} from './access';
import { formatNumber, formatPct, NA, PERCENT_EPSILON_PP, renderDelta } from './format';

// A bucket with a null pct is a legitimate 0/0 ("n/a (0/0)"), distinct from a
// missing bucket (bare "n/a"), which means the collector failed or the metric
// does not exist for that workspace.
const renderCoverageCell = (bucket: CoverageBucket | null): string => {
  if (!bucket) return NA;
  const pct = bucket.pct === null ? NA : formatPct(bucket.pct);
  return `${pct} (${formatNumber(bucket.covered)}/${formatNumber(bucket.total)})`;
};

/**
 * Covered units a crate's count moves by between two runs of the same code
 * (racy branches in the runtime's tests), measured at ±1 to ±3 regions.
 */
const CRATE_RUN_NOISE_COUNT = 3;

/**
 * Whether a crate's coverage change is within run-to-run noise: under the
 * verdict's percentage-point epsilon, or a few covered units over an unchanged
 * denominator (the instrumented total only moves when the code did). JS rows
 * are deterministic, so they always colour.
 * // Usage: isCrateCoverageNoise({ total: 1115, covered: 1111, pct: 99.64 }, { total: 1115, covered: 1108, pct: 99.37 }) // true
 */
const isCrateCoverageNoise = (
  base: CoverageBucket | null,
  head: CoverageBucket | null
): boolean => {
  if (!base || !head || base.pct === null || head.pct === null) return false;
  if (Math.abs(head.pct - base.pct) < PERCENT_EPSILON_PP) return true;
  return (
    base.total === head.total && Math.abs(head.covered - base.covered) <= CRATE_RUN_NOISE_COUNT
  );
};

const renderCoverageRow = (
  base: Metrics | null,
  head: Metrics | null,
  id: string,
  label: string,
  key: CoverageKey,
  kind: ComponentKind
): string => {
  const baseBucket = getCoverageBucket(findComponent(base, id)?.coverage, key);
  const headBucket = getCoverageBucket(findComponent(head, id)?.coverage, key);
  const baseCell = renderCoverageCell(baseBucket);
  const headCell = renderCoverageCell(headBucket);
  const delta = renderDelta(baseBucket?.pct ?? null, headBucket?.pct ?? null, {
    higherIsBetter: true,
    suffix: 'pp',
    neutral: kind === 'crate' && isCrateCoverageNoise(baseBucket, headBucket),
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
      rows.push(
        renderCoverageRow(base, head, component.id, componentLabel(component), key, component.kind)
      );
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
