import { describe, expect, it } from 'bun:test';

import type { WorkspaceName } from '../../lib/config';
import type { TestMetricsFragment } from '../model/fragment';
import type { CoverageSummary } from '../model/metrics';
import {
  type Measurement,
  measured,
  measuredValue,
  unavailable,
  unsupported,
} from '../model/states';
import { expectState } from '../testing/measurement-assertions';
import { makeCoverageSummary, makeMetrics } from '../testing/metrics-fixture';
import {
  NO_FRAGMENT,
  parseTestMetricsFragment,
  producerAbsence,
  resolveTestMetrics,
  type TestMetricsInputs,
  unusableTestMetrics,
  withheldTestMetrics,
} from './fragment';

const SOURCE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const makeFragment = (overrides: Partial<TestMetricsFragment> = {}): TestMetricsFragment => ({
  sourceSha: SOURCE_SHA,
  tests: makeMetrics(SOURCE_SHA).tests,
  coverage: { api: measured(makeCoverageSummary(77)) },
  ...overrides,
});

/** Coverage a lane would get from the inputs; a null (disk fallback) shows up as a wrong state. */
const laneCoverage = (
  inputs: TestMetricsInputs,
  lane: WorkspaceName
): Measurement<CoverageSummary> =>
  inputs.deliveredCoverage(lane) ??
  unsupported('deliveredCoverage returned null: the caller would read local coverage from disk');

describe('parseTestMetricsFragment', () => {
  it('accepts a valid fragment', () => {
    const fragment = makeFragment();

    expect(parseTestMetricsFragment(JSON.stringify(fragment))).toEqual({ fragment });
  });

  it('reports invalid JSON', () => {
    expect(parseTestMetricsFragment('{nope')).toEqual({
      error: 'test metrics fragment is not valid JSON',
    });
  });

  it('names the failing location of a malformed fragment', () => {
    const missingSha = { tests: makeFragment().tests, coverage: {} };
    const result = parseTestMetricsFragment(JSON.stringify(missingSha));

    expect(result).toEqual({
      error: expect.stringMatching(
        /test metrics fragment failed schema validation \(\/sourceSha: /
      ),
    });
  });

  it('rejects a pre-v4 fragment whose tests are a bare object rather than a measurement', () => {
    const legacy = { sourceSha: SOURCE_SHA, tests: { exitCode: 0, passed: 1 }, coverage: {} };

    expect('error' in parseTestMetricsFragment(JSON.stringify(legacy))).toBe(true);
  });
});

describe('resolveTestMetrics', () => {
  it('delivers the fragment as measured when it describes the same commit', () => {
    const inputs = resolveTestMetrics(makeFragment(), SOURCE_SHA);

    expect(expectState(inputs.tests, 'measured').value.passed).toBe(1_157);
    expect(measuredValue(inputs.deliveredCoverage('api'))?.lines.pct).toBe(77);
    expect(inputs.deliveredCoverage('frontend')).toBeNull();
  });

  it('marks every delivered value stale when the fragment measured another commit', () => {
    const inputs = resolveTestMetrics(makeFragment({ sourceSha: OTHER_SHA }), SOURCE_SHA);

    const tests = expectState(inputs.tests, 'stale');
    expect(tests.reasons[0]).toContain(`measured ${OTHER_SHA}`);
    expect(tests.reasons[0]).toContain(`envelope measures ${SOURCE_SHA}`);
    expect('value' in tests).toBe(false);
    expect(
      expectState(inputs.deliveredCoverage('api') ?? unavailable('null'), 'stale').reasons
    ).toEqual(tests.reasons);
  });

  it('keeps a failing suite failing: the fragment tests are passed through untouched', () => {
    const failing = measured({
      exitCode: 1,
      durationSeconds: 5,
      passed: 3,
      root: 0,
      frontend: 3,
      api: 0,
      shared: 0,
    });
    const inputs = resolveTestMetrics(makeFragment({ tests: failing }), SOURCE_SHA);

    expect(inputs.tests).toEqual(failing);
  });
});

describe('absent and unusable fragments', () => {
  it('a missing fragment is unavailable (producer failed, canceled or skipped), not a pass', () => {
    const tests = expectState(NO_FRAGMENT.tests, 'unavailable');

    expect(tests.reasons).toEqual(['test metrics fragment not delivered: producer missing']);
    expect(NO_FRAGMENT.deliveredCoverage('api')).toBeNull();
  });

  it('an unusable fragment is unavailable with the validation reason', () => {
    const inputs = unusableTestMetrics('test-metrics.json: not valid JSON');

    expect(expectState(inputs.tests, 'unavailable').reasons).toEqual([
      'test-metrics.json: not valid JSON',
    ]);
  });

  // Regression: a fragment that was passed but rejected must not fall back to
  // disk. On a machine with stale `.mango/artifacts/coverage`, coverage would
  // read `measured` next to `unavailable` tests.
  it('never falls back to a local coverage read after a rejected fragment', () => {
    const inputs = unusableTestMetrics('test-metrics.json: not valid JSON');

    expect(expectState(laneCoverage(inputs, 'api'), 'unavailable').reasons).toEqual([
      'test-metrics.json: not valid JSON',
    ]);
  });

  it.each(['missing', 'failed', 'canceled', 'skipped'] as const)(
    'a fragment the producer never delivered (%s) is unavailable for tests and every lane, not a disk read',
    (cause) => {
      const inputs = withheldTestMetrics(cause, './qa-test-metrics/test-metrics.json');

      const reasons = [
        `test metrics fragment ./qa-test-metrics/test-metrics.json not delivered: producer ${cause}`,
      ];
      expect(expectState(inputs.tests, 'unavailable').reasons).toEqual(reasons);
      expect(expectState(laneCoverage(inputs, 'frontend'), 'unavailable').reasons).toEqual(reasons);
    }
  );

  it('names the producer fate even when no fragment path was passed', () => {
    expect(expectState(withheldTestMetrics('canceled').tests, 'unavailable').reasons).toEqual([
      'test metrics fragment not delivered: producer canceled',
    ]);
  });
});

describe('producerAbsence', () => {
  it.each([
    ['cancelled', 'canceled'],
    ['failure', 'failed'],
    ['skipped', 'skipped'],
    ['success', 'missing'],
    ['something-new', 'missing'],
  ])('maps needs.test.result %p to %p', (result, expected) => {
    expect(producerAbsence(result)).toBe(expected as never);
  });

  it('reports no producer for an empty result, so a local run keeps reading coverage from disk', () => {
    expect(producerAbsence('')).toBeNull();
    expect(producerAbsence(undefined)).toBeNull();
  });
});
