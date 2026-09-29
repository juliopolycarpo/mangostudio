import { describe, expect, it } from 'bun:test';

import type { Metrics } from './collect/types';
import { measured, partial, stale, unavailable } from './model/states';
import { QA_METRICS_MARKER, renderDocument } from './render/document';
import {
  makeComponents,
  makeCoverageSummary,
  makeLocStats,
  makeMetrics,
} from './testing/metrics-fixture';

const makeMetricsWithFrontendLines = (sha: string, lineCoverage: number): Metrics =>
  makeMetrics(sha, {
    components: makeComponents({
      'apps/frontend': { coverage: measured(makeCoverageSummary(lineCoverage)) },
    }),
  });

describe('QA gate document renderer', () => {
  it('renders a stable marker and coverage delta', () => {
    const comment = renderDocument(
      makeMetricsWithFrontendLines('0123456789', 80),
      makeMetricsWithFrontendLines('abcdef1234', 82)
    );

    expect(comment).toContain('## QA Gate');
    expect(comment.trimEnd().endsWith(QA_METRICS_MARKER)).toBe(true);
    expect(comment).toContain('✅ **No attention signals**');
    expect(comment).toContain('Line coverage (all workspaces)');
    expect(comment).toContain('<summary>Metric details');
    expect(comment).toContain('Frontend Bundle');
    expect(comment).toContain('Dependencies');
    expect(comment).toContain('### Tests');
    expect(comment).toContain('Repo Tooling');
    expect(comment).toContain('API/shared branches and statements are source-derived');
    expect(comment).toContain('Full repo check');
    expect(comment).not.toContain('ESLint');
    expect(comment).toContain('+0.67pp');
    expect(comment).not.toContain('## Test failures');
    expect(comment).not.toContain('no failure counts could be parsed');
  });

  it('leads a failed unhandled-error run with headlines before coverage tables', () => {
    const head = makeMetrics('abcdef1234', {
      tests: measured({
        exitCode: 1,
        durationSeconds: 165,
        passed: 1_150,
        root: 4,
        frontend: 230,
        api: 770,
        shared: 96,
        failed: 0,
        failedFiles: 0,
        errors: 2,
        headlines: [
          {
            message: 'ReferenceError: window is not defined',
            originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
          },
        ],
      }),
    });
    const comment = renderDocument(makeMetrics('0123456789'), head);
    const failuresAt = comment.indexOf('## Test failures');
    const detailsAt = comment.indexOf('<summary>Metric details');

    expect(failuresAt).toBeGreaterThan(0);
    expect(failuresAt).toBeLessThan(detailsAt);
    expect(comment).toContain('ReferenceError: window is not defined');
    expect(comment).toContain('tests failing (exit 1, 2 unhandled errors)');
    expect(comment).toContain('2 unhandled errors');
  });

  it('renders a legitimate zero denominator as n/a (0/0) without a delta', () => {
    const naBucket = { total: 0, covered: 0, pct: null };
    const metricsWithNaBranches = (sha: string): Metrics =>
      makeMetrics(sha, {
        components: makeComponents({
          'apps/api': { coverage: measured({ ...makeCoverageSummary(), branches: naBucket }) },
        }),
      });

    const comment = renderDocument(
      metricsWithNaBranches('0123456789'),
      metricsWithNaBranches('abcdef1234')
    );

    expect(comment).toContain('| apps/api | branches | n/a (0/0) | n/a (0/0) | n/a |');
  });

  it('surfaces head regressions in the verdict headline', () => {
    const comment = renderDocument(
      makeMetrics('0123456789'),
      makeMetrics('abcdef1234', {
        tooling: measured({ checkExitCode: 1, failedTasks: ['typecheck'] }),
      })
    );

    expect(comment).toContain('⚠️ **Needs attention:** repo check failing: `typecheck`');
  });

  it('keeps rendering when one side is unavailable', () => {
    const comment = renderDocument(makeMetricsWithFrontendLines('0123456789', 80), null);

    expect(comment).toContain('Collector errors');
    expect(comment).toContain('metrics file was not loadable');
    expect(comment).toContain('Verdict unavailable');
  });

  // Artifact strings are untrusted: collector "error" messages and failed
  // task names must never become active Markdown/HTML in the comment.
  it('neutralizes markdown and backticks in artifact-supplied strings', () => {
    const injection = 'boom` <img src=x onerror=alert(1)>\n\n## fake heading';
    const comment = renderDocument(
      null,
      makeMetrics('abcdef1234', {
        duplication: unavailable(injection),
        tooling: measured({ checkExitCode: 1, failedTasks: ['`<script>`'] }),
      })
    );

    expect(comment).not.toContain('boom`');
    expect(comment).not.toContain('\n## fake heading');
    expect(comment).toContain("boom' <img src=x onerror=alert(1)> ## fake heading");
    expect(comment).toContain("`'<script>'`");
  });

  it('renders a row per discovered component, including one only the head has', () => {
    const head = makeMetrics('abcdef1234', {
      components: [
        ...makeComponents(),
        {
          ...makeComponents()[3],
          id: 'crate:mangostudio-launcher',
          name: 'mangostudio-launcher',
          root: 'crates/mangostudio-launcher',
        },
      ],
    });

    const comment = renderDocument(makeMetrics('0123456789'), head);

    expect(comment).toContain(
      '| crates/mango-protocol | 1 files / 100 lines | 1 files / 100 lines |'
    );
    expect(comment).toContain('| crates/mangostudio-launcher | n/a | 1 files / 100 lines |');
    expect(comment).toContain('| **total** | 4 files / 400 lines | 5 files / 500 lines |');
  });

  it('gives components without a coverage lane no coverage rows', () => {
    const comment = renderDocument(makeMetrics('0123456789'), makeMetrics('abcdef1234'));

    expect(comment).toContain('| apps/api | lines |');
    expect(comment).not.toContain('| crates/mango-protocol | lines |');
  });

  it('shows a partial LoC count as n/a with no delta and never as a lower total', () => {
    const head = makeMetrics('abcdef1234', {
      components: makeComponents({
        'apps/api': { loc: partial(makeLocStats(60), 'apps/api/a.ts: EACCES') },
      }),
    });

    const comment = renderDocument(makeMetrics('0123456789'), head);

    expect(comment).toContain(
      '| apps/api | 1 files / 100 lines | n/a (partial) | files n/a • code n/a |'
    );
    expect(comment).toContain('| **total** | 4 files / 400 lines | n/a (incomplete) |');
    expect(comment).toContain('- head/loc/apps/api: `partial: apps/api/a.ts: EACCES`');
  });

  it('lists stale and unavailable data in the notes but never unsupported cells', () => {
    const head = makeMetrics('abcdef1234', {
      tests: stale('fragment measured another commit'),
      components: makeComponents({
        'apps/shared': { coverage: unavailable('lcov missing') },
      }),
    });

    const comment = renderDocument(makeMetrics('0123456789'), head);

    expect(comment).toContain('- head/tests: `stale: fragment measured another commit`');
    expect(comment).toContain('- head/coverage/apps/shared: `unavailable: lcov missing`');
    expect(comment).not.toContain('unsupported');
  });
});
