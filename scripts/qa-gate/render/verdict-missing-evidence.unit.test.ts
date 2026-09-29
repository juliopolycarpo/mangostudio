// Regression: missing test evidence must never render the healthy verdict.
//
// Bun can print `JUnitReportFailed` and still exit 0, which the collector
// records as `parseMiss: true` under `exitCode: 0`; a run with no process
// receipt records `exitCode: null`. Both used to fall through `testSuiteItem`
// and read as "No attention signals".

import { describe, expect, it } from 'bun:test';

import { measured } from '../model/states';
import { makeMetrics } from '../testing/metrics-fixture';
import { renderVerdict } from './verdict';

const suite = (overrides: { exitCode: number | null; parseMiss?: boolean }) =>
  measured({
    durationSeconds: 240,
    passed: 1_157,
    root: 4,
    frontend: 230,
    api: 770,
    shared: 96,
    ...overrides,
  });

const base = makeMetrics('base-sha');

describe('renderVerdict with missing test evidence', () => {
  it('does not render a green verdict when a lane wrote no report under exit 0', () => {
    const head = makeMetrics('head-sha', { tests: suite({ exitCode: 0, parseMiss: true }) });

    const verdict = renderVerdict(base, head);

    expect(verdict).toContain('Needs attention');
    expect(verdict).toContain('tests');
    expect(verdict).not.toContain('No attention signals');
  });

  it('does not render a green verdict when the test process left no exit code', () => {
    const head = makeMetrics('head-sha', { tests: suite({ exitCode: null }) });

    const verdict = renderVerdict(base, head);

    expect(verdict).toContain('Needs attention');
    expect(verdict).not.toContain('No attention signals');
  });
});
