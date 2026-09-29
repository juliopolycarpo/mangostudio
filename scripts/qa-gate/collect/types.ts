// Public metric shapes produced by the QA-gate collector and consumed by the
// renderer. They are derived from the TypeBox schemas in ../model (the single
// source of truth), so this file only re-exports them. Kept separate from the
// executable so importing them has no side effect.

import type { CoverageSummary } from '../model/metrics';
import type { CoverageSummary as LcovCoverageSummary } from '../parse-lcov';

export type { TestMetricsFragment } from '../model/fragment';
export type {
  BundleStats,
  Component,
  ComponentKind,
  CoverageSummary,
  DependencyStats,
  DuplicationStats,
  LocBucket,
  LocStats,
  Metrics,
  TestErrorHeadline,
  TestSuiteStats,
  ToolingCheckStats,
} from '../model/metrics';
export type { Measurement } from '../model/states';

// Compile-time guard: the LCOV parser's hand-written summary and the schema's
// summary must accept each other, so a change to one cannot drift from the other.
const _LCOV_SUMMARY_MATCHES_SCHEMA: [CoverageSummary] extends [LcovCoverageSummary]
  ? [LcovCoverageSummary] extends [CoverageSummary]
    ? true
    : never
  : never = true;
