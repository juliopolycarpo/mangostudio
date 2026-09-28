import { describe, expect, it } from 'bun:test';

import {
  absentFromProducer,
  measured,
  partial,
  stale,
  unavailable,
  unsupported,
} from '../model/states';
import {
  makeComponents,
  makeCoverageSummary,
  makeLocStats,
  makeMetrics,
} from '../testing/metrics-fixture';
import { collectAttentionItems, renderVerdict } from './verdict';

const base = makeMetrics('base-sha');

describe('collectAttentionItems', () => {
  it('returns nothing for a healthy head', () => {
    expect(collectAttentionItems(base, makeMetrics('head-sha'))).toEqual([]);
  });

  it('flags a failing test suite and repo check with the failed tasks', () => {
    const head = makeMetrics('head-sha', {
      tests: measured({
        exitCode: 1,
        durationSeconds: 250,
        passed: 1_147,
        root: 4,
        frontend: 230,
        api: 760,
        shared: 96,
      }),
      tooling: measured({ checkExitCode: 1, failedTasks: ['typecheck'] }),
    });

    const items = collectAttentionItems(base, head);

    expect(items).toContain('tests failing (exit 1)');
    expect(items).toContain('repo check failing: `typecheck`');
  });

  it('flags TypeScript errors and circular dependencies with counts', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({
        'apps/frontend': { tsErrors: measured(2) },
        'apps/api': { tsErrors: measured(1) },
      }),
      circularDeps: measured(1),
    });

    const items = collectAttentionItems(base, head);

    expect(items).toContain('3 TypeScript errors');
    expect(items).toContain('1 circular dependency');
  });

  it('flags coverage drops, duplication growth, and bundle growth over thresholds', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({
        'apps/frontend': { coverage: measured(makeCoverageSummary(70)) },
      }),
      duplication: measured({ clones: 4, duplicatedLines: 40, percentage: 1.5 }),
      frontendBundle: measured({
        files: 4,
        rawBytes: 500_000,
        gzipBytes: 130_000,
        jsGzipBytes: 110_000,
        cssGzipBytes: 18_000,
        htmlGzipBytes: 2_000,
      }),
    });

    const items = collectAttentionItems(base, head);

    expect(items).toContain('line coverage −3.33pp');
    expect(items).toContain('duplication +1.50pp');
    expect(items).toContain('bundle gzip +29.3 KiB');
  });

  it('ignores drift below the noise thresholds', () => {
    const head = makeMetrics('head-sha', {
      duplication: measured({ clones: 0, duplicatedLines: 1, percentage: 0.05 }),
      frontendBundle: measured({
        files: 4,
        rawBytes: 400_500,
        gzipBytes: 100_500,
        jsGzipBytes: 80_500,
        cssGzipBytes: 18_000,
        htmlGzipBytes: 2_000,
      }),
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
      frontendBundle: unavailable('frontend dist at ./frontend-dist is present but not measurable'),
      duplication: unavailable('jscpd exited 1'),
    });

    expect(collectAttentionItems(base, head)).toContain(
      'metrics not collected: `duplication`, `frontendBundle`'
    );
  });

  it('flags per-workspace head collectors that returned an error', () => {
    const brokenHead = makeMetrics('head-sha', {
      components: makeComponents({
        'apps/shared': { coverage: unavailable('head shared coverage missing') },
        'apps/frontend': { tsErrors: unavailable('head frontend TypeScript count missing') },
        'apps/api': { loc: unavailable('head api LoC missing') },
      }),
    });

    expect(collectAttentionItems(base, brokenHead)).toContain(
      'metrics not collected: `tsErrors/apps/frontend`, `loc/apps/api`, `coverage/apps/shared`'
    );
  });

  // A base envelope is legitimately absent on a first run and on a forked PR.
  // Flagging that would fire on every change that broke nothing.
  it('does not flag base-side collector errors', () => {
    const staleBase = makeMetrics('base-sha', { frontendBundle: unavailable('artifact missing') });

    expect(collectAttentionItems(staleBase, makeMetrics('head-sha'))).toEqual([]);
  });
});

describe('renderVerdict', () => {
  it('renders the healthy verdict', () => {
    expect(renderVerdict(base, makeMetrics('head-sha'))).toContain('✅ **No attention signals**');
  });

  it('joins attention items into a single needs-attention line', () => {
    const head = makeMetrics('head-sha', { circularDeps: measured(2) });
    expect(renderVerdict(base, head)).toBe('⚠️ **Needs attention:** 2 circular dependencies');
  });

  it('reports when head metrics are absent entirely', () => {
    expect(renderVerdict(base, null)).toContain('Verdict unavailable');
  });

  it('warns when a nested TypeScript collector failed', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({
        'apps/frontend': { tsErrors: unavailable('tsc output was not available') },
      }),
    });

    expect(renderVerdict(base, head)).toBe(
      '⚠️ **Needs attention:** metrics not collected: `tsErrors/apps/frontend`'
    );
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

describe('explicit data states in the verdict', () => {
  // The Rust crate has no coverage lane, so its `unsupported` cells are a
  // definition, not a failure: reporting them would put the same warning on
  // every pull request.
  it('does not flag unsupported measurements as uncollected', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({ 'crates/mango-protocol': { coverage: unsupported('no lane') } }),
    });

    expect(collectAttentionItems(base, head)).toEqual([]);
  });

  it.each([
    ['partial', partial(makeLocStats(90), 'a.ts: EACCES')],
    ['stale', stale<ReturnType<typeof makeLocStats>>('measured another commit')],
    ['unavailable', unavailable<ReturnType<typeof makeLocStats>>('collector crashed')],
  ])('flags a %s measurement as uncollected', (_state, loc) => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({ 'apps/api': { loc } }),
    });

    expect(collectAttentionItems(base, head)).toContain('metrics not collected: `loc/apps/api`');
  });

  it('flags a canceled test producer instead of reading it as a pass', () => {
    const head = makeMetrics('head-sha', { tests: absentFromProducer('test job', 'canceled') });

    expect(collectAttentionItems(base, head)).toContain('metrics not collected: `tests`');
  });

  // The drop guard must survive a crate with an unsupported lane, and must go
  // n/a (not silently smaller) when a lane that should report did not.
  it('keeps the coverage drop guard on while Rust components are unsupported', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({ 'apps/api': { coverage: measured(makeCoverageSummary(60)) } }),
    });

    expect(collectAttentionItems(base, head)).toContain('line coverage −6.67pp');
  });

  it('drops the coverage comparison instead of shrinking it when a lane is unavailable', () => {
    const head = makeMetrics('head-sha', {
      components: makeComponents({ 'apps/api': { coverage: unavailable('lcov missing') } }),
    });

    expect(collectAttentionItems(base, head).some((item) => item.startsWith('line coverage'))).toBe(
      false
    );
  });
});
