// Per-crate Rust coverage in the QA report: the rows the existing coverage
// renderer emits for a crate, and how each Rust coverage state moves the
// verdict. A Rust lane that was proven irrelevant must not make a docs-only PR
// `incomplete`, while a lane that was due and delivered nothing must.

import { describe, expect, it } from 'bun:test';
import type { CoverageSummary } from '../collect/types';
import {
  type Measurement,
  measured,
  partial,
  stale,
  unavailable,
  unsupported,
} from '../model/states';
import { evaluateVerdict } from '../policy/verdict';
import {
  makeComponents,
  makeCoverageSummary,
  makeMetrics,
  makeRustCoverageSummary,
} from '../testing/metrics-fixture';
import { getTotalLineCoverage } from './access';
import { renderCoverageSection } from './coverage';
import { renderDocument } from './document';
import { renderSummary } from './summary';

const CRATE = 'crates/mango-protocol';

const withCrate = (sha: string, coverage: Measurement<CoverageSummary>) =>
  makeMetrics(sha, { components: makeComponents({ [CRATE]: { coverage } }) });

const rowsOf = (section: string, component: string): string[] =>
  section.split('\n').filter((line) => line.startsWith(`| ${component} |`));

const base = withCrate('base-sha', measured(makeRustCoverageSummary(80)));

describe('renderCoverageSection for a crate', () => {
  it('renders line, function and region rows with base, head and delta', () => {
    const head = withCrate('head-sha', measured(makeRustCoverageSummary(90)));

    const rows = rowsOf(renderCoverageSection(base, head), CRATE);

    expect(rows).toEqual([
      `| ${CRATE} | lines | 80.00% (80/100) | 90.00% (90/100) | 🟢 ▲ +10pp |`,
      `| ${CRATE} | functions | 80.00% (80/100) | 90.00% (90/100) | 🟢 ▲ +10pp |`,
      `| ${CRATE} | regions | 80.00% (80/100) | 90.00% (90/100) | 🟢 ▲ +10pp |`,
    ]);
  });

  it('shows a regression as a red delta on that crate only', () => {
    const head = withCrate('head-sha', measured(makeRustCoverageSummary(70)));

    const section = renderCoverageSection(base, head);

    expect(rowsOf(section, CRATE)[0]).toContain('🔴 ▼ -10pp');
    expect(rowsOf(section, 'apps/api')[0]).toContain('⚪ ▲ = 0');
  });

  it('has no statement or branch row for a crate, and no region row for a JS workspace', () => {
    const section = renderCoverageSection(base, base);

    expect(rowsOf(section, CRATE).some((row) => row.includes('| statements |'))).toBe(false);
    expect(rowsOf(section, CRATE).some((row) => row.includes('| branches |'))).toBe(false);
    expect(rowsOf(section, 'apps/api').some((row) => row.includes('| regions |'))).toBe(false);
  });

  it('shows n/a, not zero, when the Rust lane did not run for the change', () => {
    const head = withCrate(
      'head-sha',
      unsupported('rust coverage not run: no Rust-relevant path changed')
    );

    const rows = rowsOf(renderCoverageSection(base, head), CRATE);

    expect(rows[0]).toBe(`| ${CRATE} | lines | 80.00% (80/100) | n/a | n/a |`);
    expect(rows.every((row) => row.endsWith('| n/a | n/a |'))).toBe(true);
  });

  it('shows n/a for a crate whose profile data was lost', () => {
    const head = withCrate(
      'head-sha',
      unavailable('crates/mango-protocol: no instrumented source file')
    );

    expect(rowsOf(renderCoverageSection(base, head), CRATE)[0]).toContain('| n/a | n/a |');
  });

  it('gives a partial crate no delta, since a lower bound is not a measurement', () => {
    const head = withCrate(
      'head-sha',
      partial(makeRustCoverageSummary(40), 'instrumented test run exited 101')
    );

    expect(rowsOf(renderCoverageSection(base, head), CRATE)[0]).toContain('| n/a | n/a |');
  });

  it('renders no crate rows when neither side has Rust coverage', () => {
    const section = renderCoverageSection(makeMetrics('base-sha'), makeMetrics('head-sha'));

    expect(rowsOf(section, CRATE)).toEqual([]);
  });

  it('explains the collected dimensions in the section note', () => {
    const section = renderCoverageSection(base, base);

    expect(section).toContain('line, function and region coverage from `cargo llvm-cov`');
    expect(section).toContain('Branch coverage is not collected and doctests are not instrumented');
  });
});

describe('renderDocument with crate coverage', () => {
  it('lists an unavailable crate among the collector errors', () => {
    const head = withCrate('head-sha', unavailable('crates/mango-protocol: profile data missing'));

    const comment = renderDocument(base, head);

    expect(comment).toContain(
      '- head/coverage/crates/mango-protocol: `unavailable: crates/mango-protocol: profile data missing`'
    );
  });
});

describe('the JS line-coverage total', () => {
  it('ignores crates, so a run that measured none shifts nothing', () => {
    const withRust = withCrate('a', measured(makeRustCoverageSummary(10)));
    const withoutRust = withCrate('b', unsupported('rust coverage not run'));

    expect(getTotalLineCoverage(withRust)).toEqual(getTotalLineCoverage(withoutRust));
    expect(getTotalLineCoverage(withRust)?.covered).toBe(240);
  });

  it('is not switched off by an unavailable crate', () => {
    const head = withCrate('head-sha', unavailable('profile data missing'));

    expect(getTotalLineCoverage(head)?.pct).toBe(80);
    expect(renderSummary(base, head)).toContain('**Line coverage (all workspaces):** ⚪ ▲ = 0');
  });

  it('still reports a JS coverage drop when the crate was not run', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({
        [CRATE]: { coverage: unsupported('rust coverage not run') },
        'apps/api': { coverage: measured(makeCoverageSummary(60)) },
      }),
    });

    expect(evaluateVerdict(base, head).regressions).toContain('line coverage −6.67pp');
  });
});

describe('verdict with Rust coverage states', () => {
  it('does not call a PR incomplete because the Rust lane was proven irrelevant', () => {
    const head = withCrate(
      'head-sha',
      unsupported('rust coverage not run: no Rust-relevant path changed')
    );

    const verdict = evaluateVerdict(base, head);

    expect(verdict.outcome, `expected verdict pass | gaps: ${verdict.gaps}`).toBe('pass');
    expect(verdict.gaps).toEqual([]);
    expect(verdict.baseGaps).toEqual([]);
  });

  it.each([
    [
      'unavailable',
      unavailable<CoverageSummary>('rust coverage artifact not delivered: producer failed'),
    ],
    ['stale', stale<CoverageSummary>('rust coverage measured another commit')],
    ['partial', partial(makeRustCoverageSummary(50), 'instrumented test run exited 101')],
  ])('calls a PR incomplete when the crate is %s on the head', (_state, cell) => {
    const verdict = evaluateVerdict(base, withCrate('head-sha', cell));

    expect(verdict.outcome).toBe('incomplete');
    expect(verdict.gaps).toContain(`coverage/${CRATE}`);
  });

  it('flags an unavailable crate on the base as an incomplete comparison', () => {
    const verdict = evaluateVerdict(
      withCrate('base-sha', unavailable('profile data missing')),
      withCrate('head-sha', measured(makeRustCoverageSummary(80)))
    );

    expect(verdict.baseGaps).toContain(`coverage/${CRATE}`);
    expect(verdict.outcome).toBe('incomplete');
  });

  it('passes when the crate is measured on both sides', () => {
    const verdict = evaluateVerdict(
      base,
      withCrate('head-sha', measured(makeRustCoverageSummary(85)))
    );

    expect(verdict.outcome).toBe('pass');
  });
});
