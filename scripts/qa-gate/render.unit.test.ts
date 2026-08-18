import { describe, expect, it } from 'bun:test';

import type { Metrics } from './collect/types';
import { COMMENT_MARKER, renderDocument } from './render/document';
import { makeCoverageSummary, makeMetrics } from './testing/metrics-fixture';

const makeMetricsWithFrontendLines = (sha: string, lineCoverage: number): Metrics =>
  makeMetrics(sha, {
    coverage: {
      frontend: makeCoverageSummary(lineCoverage),
      api: makeCoverageSummary(),
      shared: makeCoverageSummary(),
      runtime: makeCoverageSummary(),
    },
  });

describe('QA gate document renderer', () => {
  it('renders a stable marker and coverage delta', () => {
    const comment = renderDocument(
      makeMetricsWithFrontendLines('0123456789', 80),
      makeMetricsWithFrontendLines('abcdef1234', 82)
    );

    expect(comment).toContain('## QA Gate');
    expect(comment.trimEnd().endsWith(COMMENT_MARKER)).toBe(true);
    expect(comment).toContain('✅ **No attention signals**');
    expect(comment).toContain('Line coverage (all workspaces)');
    expect(comment).toContain('<summary>Metric details');
    expect(comment).toContain('Frontend Bundle');
    expect(comment).toContain('Dependencies');
    expect(comment).toContain('### Tests');
    expect(comment).toContain('Repo Tooling');
    expect(comment).toContain('API/shared/runtime branches and statements are source-derived');
    expect(comment).toContain('Full repo check');
    expect(comment).not.toContain('ESLint');
    expect(comment).toContain('+0.50pp');
    expect(comment).not.toContain('## Test failures');
    expect(comment).not.toContain('no failure counts could be parsed');
  });

  it('leads a failed unhandled-error run with headlines before coverage tables', () => {
    const head = makeMetrics('abcdef1234', {
      tests: {
        exitCode: 1,
        durationSeconds: 165,
        passed: 1_150,
        root: 4,
        frontend: 230,
        api: 770,
        shared: 96,
        runtime: 57,
        failed: 0,
        failedFiles: 0,
        errors: 2,
        headlines: [
          {
            message: 'ReferenceError: window is not defined',
            originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
          },
        ],
      },
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
        coverage: {
          frontend: makeCoverageSummary(),
          api: { ...makeCoverageSummary(), branches: naBucket },
          shared: makeCoverageSummary(),
          runtime: makeCoverageSummary(),
        },
      });

    const comment = renderDocument(
      metricsWithNaBranches('0123456789'),
      metricsWithNaBranches('abcdef1234')
    );

    expect(comment).toContain('| api | branches | n/a (0/0) | n/a (0/0) | n/a |');
  });

  it('surfaces head regressions in the verdict headline', () => {
    const comment = renderDocument(
      makeMetrics('0123456789'),
      makeMetrics('abcdef1234', { tooling: { checkExitCode: 1, failedTasks: ['typecheck'] } })
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
        duplication: { error: injection },
        tooling: { checkExitCode: 1, failedTasks: ['`<script>`'] },
      })
    );

    expect(comment).not.toContain('boom`');
    expect(comment).not.toContain('\n## fake heading');
    expect(comment).toContain("boom' <img src=x onerror=alert(1)> ## fake heading");
    expect(comment).toContain("`'<script>'`");
  });
});
