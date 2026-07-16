// Pure composition of the consolidated PR QA report comment: run status,
// commit summary, changelog preview, and the QA metrics comparison, ending in
// the stable marker the publisher uses to update the comment in place.
// I/O (git, git-cliff, artifact files) lives in render-report.ts.

import type { Metrics } from './collect/types';
import { COMMENT_MARKER, renderDocument } from './render/document';
import { inlineCode, shortSha } from './render/format';

/** GitHub rejects issue/PR comment bodies over this many characters (422). */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** Budget for the changelog preview section inside the shared comment. */
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

const truncateSection = (text: string, maxLength: number, note: string): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n\n${note}`;

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

/** Clamp a composed report to GitHub's comment limit, keeping the marker. */
export const clampReportBody = (body: string): string => {
  if (body.length <= GITHUB_COMMENT_LIMIT) return body;
  const notice = "\n\n_…report truncated to fit GitHub's comment size limit…_\n\n";
  const keep = GITHUB_COMMENT_LIMIT - notice.length - COMMENT_MARKER.length;
  return `${body.slice(0, keep)}${notice}${COMMENT_MARKER}`;
};

/**
 * Compose the full consolidated report comment (ends with the QA marker).
 * // Usage: composeReport(status, { commits, changelog }, baseMetrics, headMetrics)
 */
export const composeReport = (
  status: ReportStatus,
  sections: ReportSections,
  base: Metrics | null,
  head: Metrics | null
): string => {
  const parts = [
    statusBlock(status),
    sections.commits ?? '## Commits\n\n_Commit summary failed to render for this run._',
    truncateSection(
      sections.changelog ??
        '## 📝 Changelog Preview\n\n_Changelog preview failed to render for this run._',
      CHANGELOG_SECTION_MAX_LENGTH,
      '_…changelog preview truncated…_'
    ),
    // renderDocument ends with COMMENT_MARKER, which must close the comment.
    renderDocument(base, head),
  ];
  return clampReportBody(parts.join('\n\n'));
};
