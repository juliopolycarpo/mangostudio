import { describe, expect, it } from 'bun:test';

import { makeCoverageSummary, makeMetrics } from '../testing/metrics-fixture';
import { collectAttentionItems, renderVerdict } from './verdict';

const base = makeMetrics('base-sha');

describe('collectAttentionItems', () => {
  it('returns nothing for a healthy head', () => {
    expect(collectAttentionItems(base, makeMetrics('head-sha'))).toEqual([]);
  });

  it('flags a failing test suite and repo check with the failed tasks', () => {
    const head = makeMetrics('head-sha', {
      tests: {
        exitCode: 1,
        durationSeconds: 250,
        passed: 1_147,
        root: 4,
        frontend: 230,
        api: 760,
        shared: 96,
        runtime: 57,
      },
      tooling: { checkExitCode: 1, failedTasks: ['typecheck'] },
    });

    const items = collectAttentionItems(base, head);

    expect(items).toContain('tests failing (exit 1)');
    expect(items).toContain('repo check failing: `typecheck`');
  });

  it('flags TypeScript errors and circular dependencies with counts', () => {
    const head = makeMetrics('head-sha', {
      tsErrors: { frontend: 2, api: 1, shared: 0, runtime: 0 },
      circularDeps: 1,
    });

    const items = collectAttentionItems(base, head);

    expect(items).toContain('3 TypeScript errors');
    expect(items).toContain('1 circular dependency');
  });

  it('flags coverage drops, duplication growth, and bundle growth over thresholds', () => {
    const head = makeMetrics('head-sha', {
      coverage: {
        frontend: makeCoverageSummary(70),
        api: makeCoverageSummary(),
        shared: makeCoverageSummary(),
        runtime: makeCoverageSummary(),
      },
      duplication: { clones: 4, duplicatedLines: 40, percentage: 1.5 },
      frontendBundle: {
        files: 4,
        rawBytes: 500_000,
        gzipBytes: 130_000,
        jsGzipBytes: 110_000,
        cssGzipBytes: 18_000,
        htmlGzipBytes: 2_000,
      },
    });

    const items = collectAttentionItems(base, head);

    expect(items).toContain('line coverage −2.50pp');
    expect(items).toContain('duplication +1.50pp');
    expect(items).toContain('bundle gzip +29.3 KiB');
  });

  it('ignores drift below the noise thresholds', () => {
    const head = makeMetrics('head-sha', {
      duplication: { clones: 0, duplicatedLines: 1, percentage: 0.05 },
      frontendBundle: {
        files: 4,
        rawBytes: 400_500,
        gzipBytes: 100_500,
        jsGzipBytes: 80_500,
        cssGzipBytes: 18_000,
        htmlGzipBytes: 2_000,
      },
    });

    expect(collectAttentionItems(base, head)).toEqual([]);
  });

  it('skips comparative signals when a side is missing instead of guessing', () => {
    expect(collectAttentionItems(null, makeMetrics('head-sha'))).toEqual([]);
  });

  // The signature of a collector that broke: every comparative item returns
  // null when a side is missing, so without this the headline reads "no
  // attention signals" at the moment nothing is being measured.
  it('flags head collectors that returned an error instead of a measurement', () => {
    const head = makeMetrics('head-sha', {
      frontendBundle: { error: 'frontend dist at ./frontend-dist is present but not measurable' },
      duplication: { error: 'jscpd exited 1' },
    });

    expect(collectAttentionItems(base, head)).toContain(
      'metrics not collected: `duplication`, `frontendBundle`'
    );
  });

  // A base envelope is legitimately absent on a first run and on a forked PR.
  // Flagging that would fire on every change that broke nothing.
  it('does not flag base-side collector errors', () => {
    const staleBase = makeMetrics('base-sha', { frontendBundle: { error: 'artifact missing' } });

    expect(collectAttentionItems(staleBase, makeMetrics('head-sha'))).toEqual([]);
  });
});

describe('renderVerdict', () => {
  it('renders the healthy verdict', () => {
    expect(renderVerdict(base, makeMetrics('head-sha'))).toContain('✅ **No attention signals**');
  });

  it('joins attention items into a single needs-attention line', () => {
    const head = makeMetrics('head-sha', { circularDeps: 2 });
    expect(renderVerdict(base, head)).toBe('⚠️ **Needs attention:** 2 circular dependencies');
  });

  it('reports when head metrics are absent entirely', () => {
    expect(renderVerdict(base, null)).toContain('Verdict unavailable');
  });

  // A missing base must not produce the "healthy against base" claim: the
  // comparative checks never ran.
  it('qualifies the healthy verdict when comparisons were unavailable', () => {
    const verdict = renderVerdict(null, makeMetrics('head-sha'));

    expect(verdict).toContain('✅ **No attention signals**');
    expect(verdict).toContain('comparisons were unavailable');
    expect(verdict).not.toContain('healthy against base');
  });
});
