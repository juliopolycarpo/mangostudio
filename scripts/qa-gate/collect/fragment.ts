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

/** No `--test-metrics` flag was passed (a local run): tests are unavailable and coverage is read from disk. */
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

/**
 * A fragment that was passed but cannot be used, e.g. it failed validation.
 * Tests and every lane are unavailable with the same reason: a rejected
 * fragment never means "try the disk", which could pair stale local coverage
 * with unavailable tests.
 * // Usage: unusableTestMetrics('test-metrics.json: not valid JSON')
 */
export const unusableTestMetrics = (reason: string): TestMetricsInputs => ({
  tests: unavailable(reason),
  deliveredCoverage: () => unavailable(reason),
});

/**
 * A fragment path that was passed but does not exist: the Test job's output
 * never arrived, so tests and every lane are unavailable rather than read from
 * disk.
 * // Usage: missingTestMetrics('./qa-test-metrics/test-metrics.json')
 */
export const missingTestMetrics = (path: string): TestMetricsInputs =>
  unusableTestMetrics(`test metrics fragment ${path} not found`);
