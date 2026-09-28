// Reads the Test job's metrics fragment on the collector side and turns every
// way it can go wrong into an explicit state: absent (the producer failed, was
// canceled or skipped), malformed (unavailable), or measured on another commit
// (stale). None of them is a zero or a pass.

import { describeSchemaError } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import type { WorkspaceName } from '../../lib/config';
import { type TestMetricsFragment, TestMetricsFragmentSchema } from '../model/fragment';
import type { CoverageSummary, TestSuiteStats } from '../model/metrics';
import { absentFromProducer, type Measurement, stale, unavailable } from '../model/states';

/** What the fragment contributes to the envelope. */
export interface TestMetricsInputs {
  readonly tests: Measurement<TestSuiteStats>;
  /** Coverage the fragment delivered for a lane; null means fall back to a local read. */
  readonly deliveredCoverage: (lane: WorkspaceName) => Measurement<CoverageSummary> | null;
}

/**
 * Parse fragment JSON text; the error names the invalid location.
 * // Usage: const parsed = parseTestMetricsFragment(await Bun.file(path).text());
 */
export const parseTestMetricsFragment = (
  text: string
): { readonly fragment: TestMetricsFragment } | { readonly error: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'test metrics fragment is not valid JSON' };
  }
  if (!Value.Check(TestMetricsFragmentSchema, parsed)) {
    const reason = describeSchemaError(
      Value.Errors(TestMetricsFragmentSchema, parsed),
      'unknown schema violation'
    );
    return { error: `test metrics fragment failed schema validation (${reason})` };
  }
  return { fragment: parsed };
};

/** Fragment absent with no reason recorded: local runs read coverage from disk. */
export const NO_FRAGMENT: TestMetricsInputs = {
  tests: absentFromProducer('test metrics fragment', 'missing'),
  deliveredCoverage: () => null,
};

/**
 * Resolve a loaded fragment against the commit the envelope measures.
 * // Usage: resolveTestMetrics(fragment, sourceSha)
 */
export const resolveTestMetrics = (
  fragment: TestMetricsFragment,
  sourceSha: string
): TestMetricsInputs => {
  if (fragment.sourceSha === sourceSha) {
    return {
      tests: fragment.tests,
      deliveredCoverage: (lane) => fragment.coverage[lane] ?? null,
    };
  }
  const reason = `test metrics fragment measured ${fragment.sourceSha}, envelope measures ${sourceSha}`;
  return { tests: stale(reason), deliveredCoverage: () => stale(reason) };
};

/** A fragment that exists but cannot be used, e.g. failed validation. */
export const unusableTestMetrics = (reason: string): TestMetricsInputs => ({
  tests: unavailable(reason),
  deliveredCoverage: () => null,
});
