// The Test job's hand-off to the collector: suite outcome plus coverage,
// stamped with the commit it measured so the collector can tell a fragment
// from another commit (stale) apart from one that never arrived (unavailable).

import Type, { type Static } from 'typebox';

import { SHA_PATTERN } from './envelope';
import { CoverageSummarySchema, TestSuiteStatsSchema } from './metrics';
import { measurement } from './states';

export const TestMetricsFragmentSchema = Type.Object(
  {
    sourceSha: Type.String({ pattern: SHA_PATTERN }),
    tests: measurement(TestSuiteStatsSchema),
    /** Coverage keyed by the workspace (or, later, crate) the lane measured. */
    coverage: Type.Record(
      Type.String({ pattern: '^[A-Za-z0-9_.-]{1,80}$' }),
      measurement(CoverageSummarySchema)
    ),
  },
  { additionalProperties: false }
);

export type TestMetricsFragment = Static<typeof TestMetricsFragmentSchema>;
