import { describe, expect, it } from 'bun:test';

import { COMMENT_MARKER } from './render/document';
import {
  clampReportBody,
  composeReport,
  GITHUB_COMMENT_LIMIT,
  type ReportStatus,
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

describe('composeReport', () => {
  it('assembles status, commits, changelog, and QA sections with one trailing marker', () => {
    const report = composeReport(
      status(),
      sections,
      makeMetrics(BASE_SHA),
      makeMetrics(HEAD_SHA),
      makeCiDurations()
    );

    expect(report).toContain('**PR head:** `fedcba9`');
    expect(report).toContain('[CI run](https://example.test/runs/1)');
    expect(report).toContain('## Commits — 1 commit');
    expect(report).toContain('## 📝 Changelog Preview');
    expect(report).toContain('### CI Duration');
    expect(report).toContain('## QA Gate — Coverage & Quality');
    expect(report.endsWith(COMMENT_MARKER)).toBe(true);
    expect(report.indexOf(COMMENT_MARKER)).toBe(report.lastIndexOf(COMMENT_MARKER));
  });

  it('renders availability notes and sanitizes their untrusted parts', () => {
    const report = composeReport(
      status({
        headNote: 'metrics payload failed schema validation (`/evil`: injection)',
        baseNote: `no successful main CI run found for base ${BASE_SHA}`,
      }),
      sections,
      null,
      null,
      null
    );

    expect(report).toContain('⚠️ Head metrics unavailable:');
    expect(report).toContain('ℹ️ Baseline unavailable');
    expect(report).toContain("`metrics payload failed schema validation ('/evil': injection)`");
  });

  it('falls back to placeholder sections when rendering failed', () => {
    const report = composeReport(
      status(),
      { commits: null, changelog: null },
      null,
      makeMetrics(HEAD_SHA),
      null
    );

    expect(report).toContain('_Commit summary failed to render for this run._');
    expect(report).toContain('_Changelog preview failed to render for this run._');
  });

  it('truncates an oversized changelog section', () => {
    const report = composeReport(
      status(),
      { ...sections, changelog: `## 📝 Changelog Preview\n\n${'x'.repeat(20_000)}` },
      makeMetrics(BASE_SHA),
      makeMetrics(HEAD_SHA),
      null
    );

    expect(report).toContain('_…changelog preview truncated…_');
    expect(report.endsWith(COMMENT_MARKER)).toBe(true);
  });
});

describe('clampReportBody', () => {
  it('returns short bodies unchanged', () => {
    expect(clampReportBody(`short\n${COMMENT_MARKER}`)).toBe(`short\n${COMMENT_MARKER}`);
  });

  it('clamps oversized bodies to the GitHub limit while keeping the marker', () => {
    const clamped = clampReportBody(`${'y'.repeat(GITHUB_COMMENT_LIMIT + 100)}\n${COMMENT_MARKER}`);

    expect(clamped.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(clamped.endsWith(COMMENT_MARKER)).toBe(true);
    expect(clamped).toContain('report truncated');
  });
});
