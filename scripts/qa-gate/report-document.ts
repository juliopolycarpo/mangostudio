// Pure composition of the two managed PR comments: the QA metrics comment
// (run status, CI durations, metrics comparison; ends with QA_METRICS_MARKER)
// and the commits comment (commit summary, changelog preview; ends with
// QA_COMMITS_MARKER). Each is composed and clamped on its own, so neither can
// starve or break the other. I/O (git, git-cliff, artifact files) lives in
// render-report.ts.

import { renderChangelogPreviewSection } from '../lib/changelog';
import { COLLAPSE_THRESHOLD } from '../lib/collapsible';
import type { CiDurationComparison } from './ci-durations';
import type { Metrics } from './collect/types';
import { renderCiDurationSection } from './render/ci';
import { QA_METRICS_MARKER, renderDocument } from './render/document';
import { escapeHtml, inlineCode, shortSha } from './render/format';

/** GitHub rejects issue/PR comment bodies over this many characters (422). */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** Marker closing the commits + changelog comment (update-or-create target). */
export const QA_COMMITS_MARKER = '<!-- qa-gate-commits-comment -->';

/** Budget for the changelog preview entries inside the commits comment. */
const CHANGELOG_SECTION_MAX_LENGTH = 10_000;

export interface ReportStatus {
  readonly headSha: string;
  readonly baseSha: string;
  readonly runUrl: string;
  /** Reason head metrics are unavailable (validation/download failure). */
  readonly headNote: string | null;
  /** Reason the exact-base baseline is unavailable. */
  readonly baseNote: string | null;
}

export interface ReportSections {
  /** Rendered commits section, or null when rendering failed. */
  readonly commits: string | null;
  /** Rendered changelog preview section, or null when rendering failed. */
  readonly changelog: string | null;
}

const statusBlock = (status: ReportStatus): string => {
  const lines = [
    `**PR head:** \`${shortSha(status.headSha)}\` • **base:** \`${shortSha(status.baseSha)}\` • [CI run](${status.runUrl})`,
  ];
  if (status.headNote) {
    lines.push('', `> ⚠️ Head metrics unavailable: ${inlineCode(status.headNote)}`);
  }
  if (status.baseNote) {
    lines.push(
      '',
      `> ℹ️ Baseline unavailable — base columns render as n/a: ${inlineCode(status.baseNote)}.`,
      "> An exact baseline is published by the first green CI run on `main` whose commit is this PR's base."
    );
  }
  return lines.join('\n');
};

/** Clamp a composed comment to GitHub's comment limit, keeping its closing marker. */
export const clampReportBody = (body: string, marker: string): string => {
  if (body.length <= GITHUB_COMMENT_LIMIT) return body;
  const notice = "\n\n_…report truncated to fit GitHub's comment size limit…_\n\n";
  const keep = GITHUB_COMMENT_LIMIT - notice.length - marker.length;
  return `${body.slice(0, keep)}${notice}${marker}`;
};

/**
 * Render git-cliff preview output for the commits comment: entries stay
 * expanded up to COLLAPSE_THRESHOLD and fold above it, independently of the
 * commit list. Commit text in the output is HTML-escaped.
 * // Usage: renderChangelogForComment(cliffStdout)
 */
export const renderChangelogForComment = (cliffOutput: string): string =>
  renderChangelogPreviewSection(escapeHtml(cliffOutput), {
    collapseAbove: COLLAPSE_THRESHOLD,
    maxLength: CHANGELOG_SECTION_MAX_LENGTH,
  });

/**
 * Compose the QA metrics comment (ends with QA_METRICS_MARKER).
 * // Usage: composeMetricsReport(status, baseMetrics, headMetrics, ciDurations, ciNote)
 */
export const composeMetricsReport = (
  status: ReportStatus,
  base: Metrics | null,
  head: Metrics | null,
  ciDurations: CiDurationComparison | null,
  ciNote: string | null = null
): string => {
  const parts = [
    statusBlock(status),
    renderCiDurationSection(ciDurations, ciNote),
    // renderDocument ends with QA_METRICS_MARKER, which must close the comment.
    renderDocument(base, head),
  ];
  return clampReportBody(parts.join('\n\n'), QA_METRICS_MARKER);
};

/**
 * Compose the commits + changelog comment (ends with QA_COMMITS_MARKER). A
 * section that failed to render (null) becomes an explicit unavailable note.
 * // Usage: composeCommitsReport({ commits, changelog })
 */
export const composeCommitsReport = (sections: ReportSections): string => {
  const parts = [
    sections.commits ?? '## Commits\n\n_Commit summary failed to render for this run._',
    sections.changelog ??
      '## 📝 Changelog Preview\n\n_Changelog preview failed to render for this run._',
    QA_COMMITS_MARKER,
  ];
  return clampReportBody(parts.join('\n\n'), QA_COMMITS_MARKER);
};
