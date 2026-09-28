import { describe, expect, it } from 'bun:test';

import type { TestMetricsFragment } from '../model/fragment';
import { measured, measuredValue, unavailable } from '../model/states';
import { expectState } from '../testing/measurement-assertions';
import { makeCoverageSummary, makeMetrics } from '../testing/metrics-fixture';
import {
  NO_FRAGMENT,
  parseTestMetricsFragment,
  resolveTestMetrics,
  unusableTestMetrics,
} from './fragment';

const SOURCE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const makeFragment = (overrides: Partial<TestMetricsFragment> = {}): TestMetricsFragment => ({
  sourceSha: SOURCE_SHA,
  tests: makeMetrics(SOURCE_SHA).tests,
  coverage: { api: measured(makeCoverageSummary(77)) },
  ...overrides,
});

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
});
