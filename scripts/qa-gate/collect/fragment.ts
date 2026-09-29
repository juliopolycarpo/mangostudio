// Reads the Test job's metrics fragment on the collector side and turns every
// way it can go wrong into an explicit state: absent (the producer failed, was
// canceled or skipped), malformed (unavailable), or measured on another commit
// (stale). None of them is a zero or a pass.

import { describeSchemaError } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import type { WorkspaceName } from '../../lib/config';
import { type TestMetricsFragment, TestMetricsFragmentSchema } from '../model/fragment';
import type { CoverageSummary, TestSuiteStats } from '../model/metrics';
import {
  absentFromProducer,
  type Measurement,
  type ProducerAbsence,
  stale,
  unavailable,
} from '../model/states';

/** What the fragment contributes to the envelope. */
export interface TestMetricsInputs {
  readonly tests: Measurement<TestSuiteStats>;
  /** Coverage the fragment delivered for a lane; null (only with no fragment at all) means read locally. */
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
      // A delivered fragment is the whole answer: a lane it lacks is unavailable,
      // never a reason to read stale coverage from disk.
      deliveredCoverage: (lane) =>
        fragment.coverage[lane] ?? unavailable(`fragment delivered no coverage for ${lane}`),
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
 * Fragment the Test job never delivered. Tests and every lane are unavailable
 * with the producer's fate as the reason, rather than read from disk.
 * // Usage: withheldTestMetrics('canceled', './qa-test-metrics/test-metrics.json')
 */
export const withheldTestMetrics = (cause: ProducerAbsence, path?: string): TestMetricsInputs => {
  const cell = absentFromProducer<never>(
    path ? `test metrics fragment ${path}` : 'test metrics fragment',
    cause
  );
  return { tests: cell, deliveredCoverage: () => cell };
};

/**
 * Map the Test job's Actions result (`needs.test.result`) to what happened to
 * its fragment. Null for an empty value (a local run, no producer to ask).
 * A `success` with no fragment is still `missing`: the job ran but delivered nothing.
 * // Usage: producerAbsence('cancelled') // 'canceled'
 */
export const producerAbsence = (result: string | undefined): ProducerAbsence | null => {
  switch (result) {
    case undefined:
    case '':
      return null;
    case 'cancelled':
      return 'canceled';
    case 'failure':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'missing';
  }
};
