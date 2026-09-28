import { describe, expect, it } from 'bun:test';

import { type CommitEntry, renderCommitsSection } from './commit-log';
import { QA_METRICS_MARKER } from './render/document';
import {
  clampReportBody,
  composeCommitsReport,
  composeMetricsReport,
  GITHUB_COMMENT_LIMIT,
  QA_COMMITS_MARKER,
  type ReportStatus,
  renderChangelogForComment,
} from './report-document';
import { makeCiDurations, makeMetrics } from './testing/metrics-fixture';

const HEAD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

const status = (overrides: Partial<ReportStatus> = {}): ReportStatus => ({
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  runUrl: 'https://example.test/runs/1',
  headNote: null,
  baseNote: null,
  ...overrides,
});

const sections = {
  commits: '## Commits — 1 commit\n\n- `aaaa111` feat: thing',
  changelog: '## 📝 Changelog Preview\n\n- feat: thing',
};

describe('composeMetricsReport', () => {
  it('assembles status, CI durations, and QA sections with one trailing marker and no commit content', () => {
    const report = composeMetricsReport(
      status(),
      makeMetrics(BASE_SHA),
      makeMetrics(HEAD_SHA),
      makeCiDurations()
    );

    expect(report).toContain('**PR head:** `fedcba9`');
    expect(report).toContain('[CI run](https://example.test/runs/1)');
    expect(report).toContain('### CI Duration');
    expect(report).toContain('## QA Gate — Coverage & Quality');
    expect(report).not.toContain('## Commits');
    expect(report).not.toContain('Changelog Preview');
    expect(report.endsWith(QA_METRICS_MARKER)).toBe(true);
    expect(report.indexOf(QA_METRICS_MARKER)).toBe(report.lastIndexOf(QA_METRICS_MARKER));
    expect(report).not.toContain(QA_COMMITS_MARKER);
  });

  it('renders availability notes and sanitizes their untrusted parts', () => {
    const report = composeMetricsReport(
      status({
        headNote: 'metrics payload failed schema validation (`/evil`: injection)',
        baseNote: `no successful main CI run found for base ${BASE_SHA}`,
      }),
      null,
      null,
      null
    );

    expect(report).toContain('⚠️ Head metrics unavailable:');
    expect(report).toContain('ℹ️ Baseline unavailable');
    expect(report).toContain("`metrics payload failed schema validation ('/evil': injection)`");
    expect(report.endsWith(QA_METRICS_MARKER)).toBe(true);
  });
});

describe('composeCommitsReport', () => {
  it('assembles commits and changelog with one trailing marker and no QA content', () => {
    const report = composeCommitsReport(sections);

    expect(report).toContain('## Commits — 1 commit');
    expect(report).toContain('## 📝 Changelog Preview');
    expect(report).not.toContain('QA Gate');
    expect(report.endsWith(QA_COMMITS_MARKER)).toBe(true);
    expect(report.indexOf(QA_COMMITS_MARKER)).toBe(report.lastIndexOf(QA_COMMITS_MARKER));
    expect(report).not.toContain(QA_METRICS_MARKER);
  });

  it('falls back to explicit unavailable sections when rendering failed', () => {
    const report = composeCommitsReport({ commits: null, changelog: null });

    expect(report).toContain('_Commit summary failed to render for this run._');
    expect(report).toContain('_Changelog preview failed to render for this run._');
    expect(report.endsWith(QA_COMMITS_MARKER)).toBe(true);
  });

  it('keeps the changelog when only the commit summary failed, and vice versa', () => {
    const noCommits = composeCommitsReport({ ...sections, commits: null });
    const noChangelog = composeCommitsReport({ ...sections, changelog: null });

    expect(noCommits).toContain('_Commit summary failed to render for this run._');
    expect(noCommits).toContain('- feat: thing');
    expect(noChangelog).toContain('_Changelog preview failed to render for this run._');
    expect(noChangelog).toContain('- `aaaa111` feat: thing');
  });
});

// The commit list and the changelog entries fold independently: each is
// counted on its own real items and renders expanded up to five.
describe('commits and changelog fold independently', () => {
  const RANGE = { baseSha: BASE_SHA, headSha: HEAD_SHA };
  const commits = (count: number): CommitEntry[] =>
    Array.from({ length: count }, (_, index) => ({
      sha: `${index + 1}`.padStart(7, '0') + 'a'.repeat(33),
      subject: `feat: commit ${index + 1}`,
      message: `feat: commit ${index + 1}`,
    }));
  const cliff = (count: number): string =>
    [
      '## [Unreleased]',
      '',
      '### 🚀 Features',
      '',
      ...Array.from({ length: count }, (_, index) => `- **(api)** Entry ${index + 1}`),
      '',
    ].join('\n');
  const compose = (commitCount: number, entryCount: number): string =>
    composeCommitsReport({
      commits: renderCommitsSection(commits(commitCount), RANGE),
      changelog: renderChangelogForComment(cliff(entryCount)),
    });
  const commitsFolded = (report: string, count: number): boolean =>
    report.includes(`<summary>${count} commits</summary>`);
  const changelogFolded = (report: string, count: number): boolean =>
    report.includes(`<summary>${count} changelog entries</summary>`);

  it.each([
    { commitCount: 0, entryCount: 0, commitsFold: false, changelogFold: false },
    { commitCount: 5, entryCount: 5, commitsFold: false, changelogFold: false },
    { commitCount: 6, entryCount: 6, commitsFold: true, changelogFold: true },
    { commitCount: 5, entryCount: 6, commitsFold: false, changelogFold: true },
    { commitCount: 6, entryCount: 5, commitsFold: true, changelogFold: false },
  ])('$commitCount commits + $entryCount entries', (row) => {
    const report = compose(row.commitCount, row.entryCount);

    expect(commitsFolded(report, row.commitCount)).toBe(row.commitsFold);
    expect(changelogFolded(report, row.entryCount)).toBe(row.changelogFold);
    expect(report.endsWith(QA_COMMITS_MARKER)).toBe(true);
  });

  it('shows an explicit empty state instead of a fold when there is nothing to list', () => {
    const report = compose(0, 0);

    expect(report).toContain('_No commits between base and head._');
    expect(report).toContain('_No changelog-relevant commits on this branch yet._');
  });

  it('truncates an oversized changelog without unbalancing its details block', () => {
    const changelog = renderChangelogForComment(cliff(3_000));
    const report = composeCommitsReport({ ...sections, changelog });

    expect(report).toContain('_…changelog preview truncated…_');
    expect(report).toContain('<summary>3000 changelog entries</summary>');
    expect(report.match(/<details>/g)).toHaveLength(report.match(/<\/details>/g)?.length ?? -1);
    expect(report.endsWith(QA_COMMITS_MARKER)).toBe(true);
  });
});

describe('clampReportBody', () => {
  it('returns short bodies unchanged', () => {
    expect(clampReportBody(`short\n${QA_METRICS_MARKER}`, QA_METRICS_MARKER)).toBe(
      `short\n${QA_METRICS_MARKER}`
    );
  });

  it.each([QA_METRICS_MARKER, QA_COMMITS_MARKER])(
    'clamps oversized bodies to the GitHub limit while keeping %s',
    (marker) => {
      const clamped = clampReportBody(
        `${'y'.repeat(GITHUB_COMMENT_LIMIT + 100)}\n${marker}`,
        marker
      );

      expect(clamped.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
      expect(clamped.endsWith(marker)).toBe(true);
      expect(clamped).toContain('report truncated');
    }
  );
});
