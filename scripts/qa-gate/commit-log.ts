// Pure rendering for the commit-summary section of the PR commits comment: a
// compact commit list (folded once it outgrows COLLAPSE_THRESHOLD) plus an
// expandable section with each full commit message. The git invocation lives
// in render-report.ts; everything here is testable without git.

import { collapseWhenLong } from '../lib/collapsible';
import { escapeBackticks, escapeHtml, shortSha } from './render/format';

// Unit separators emitted by `git log --format` (%x1f / %x1e) so parsing
// never collides with characters inside commit messages.
export const COMMIT_FIELD_SEPARATOR = '\u001f';
export const COMMIT_RECORD_SEPARATOR = '\u001e';

/** git log format string producing parseCommitLog's input. */
export const COMMIT_LOG_FORMAT = '%H%x1f%s%x1f%B%x1e';

export interface CommitEntry {
  readonly sha: string;
  readonly subject: string;
  readonly message: string;
}

/**
 * Parse `git log --format=COMMIT_LOG_FORMAT` output into commit entries.
 * // Usage: parseCommitLog(stdout)
 */
export const parseCommitLog = (raw: string): CommitEntry[] => {
  const entries: CommitEntry[] = [];
  for (const record of raw.split(COMMIT_RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\n/, '');
    if (trimmed.trim().length === 0) continue;
    // %B is raw, so a body containing the separator splits further; rejoin the
    // tail instead of silently truncating the message.
    const [sha, subject, ...rest] = trimmed.split(COMMIT_FIELD_SEPARATOR);
    if (!sha || subject === undefined || rest.length === 0) continue;
    entries.push({
      sha: sha.trim(),
      subject,
      message: rest.join(COMMIT_FIELD_SEPARATOR).trimEnd(),
    });
  }
  return entries;
};

// Fence one backtick longer than any run inside the body (minimum four) so a
// commit message can never break out of its code block.
const fenceFor = (text: string): string => {
  const longestRun = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return '`'.repeat(Math.max(4, longestRun + 1));
};

// A subject is plain text inside a list item or heading: HTML-escaped so it
// cannot forge markup or a managed-comment marker, and backtick-escaped so it
// cannot open a code span that would show the entities literally.
const subjectText = (subject: string): string => escapeBackticks(escapeHtml(subject));

// The full message sits in a fenced code block, where HTML is already literal
// (escaping there would show `&lt;` verbatim); the fence is sized past any
// backtick run in it, so it cannot break out.
const renderFullMessage = (entry: CommitEntry): string => {
  const fence = fenceFor(entry.message);
  return [
    `#### \`${shortSha(entry.sha)}\` ${subjectText(entry.subject)}`,
    '',
    `${fence}text`,
    entry.message,
    fence,
  ].join('\n');
};

// The section shares one GitHub comment (65,536-char cap) with the changelog
// preview, so it gets most of that budget by default and drops the
// full-message block first when a long-lived branch outgrows it.
const COMMITS_SECTION_MAX_LENGTH = 40_000;

// One list item per real commit, so the fold threshold counts commits and
// never headings or wrapped lines.
const commitListBlock = (entries: readonly CommitEntry[]): string =>
  collapseWhenLong(
    entries.length,
    `${entries.length} commits`,
    entries.map((entry) => `- \`${shortSha(entry.sha)}\` ${subjectText(entry.subject)}`).join('\n')
  );

const fullMessagesLines = (entries: readonly CommitEntry[]): string[] => [
  '',
  '<details>',
  '<summary>Full commit messages</summary>',
  '',
  entries.map(renderFullMessage).join('\n\n'),
  '',
  '</details>',
];

/**
 * Render the commit-summary section markdown (base..head, oldest first).
 * // Usage: renderCommitsSection(entries, { baseSha, headSha })
 */
export const renderCommitsSection = (
  entries: readonly CommitEntry[],
  range: { baseSha: string; headSha: string },
  maxLength: number = COMMITS_SECTION_MAX_LENGTH
): string => {
  const count = entries.length;
  const head = [
    `## Commits — ${count} commit${count === 1 ? '' : 's'}`,
    '',
    `Base \`${shortSha(range.baseSha)}\` → head \`${shortSha(range.headSha)}\`, oldest first.`,
    '',
  ];

  if (count === 0) {
    return [...head, '_No commits between base and head._'].join('\n');
  }

  const list = commitListBlock(entries);
  const withMessages = [...head, list, ...fullMessagesLines(entries)].join('\n');
  if (withMessages.length <= maxLength) return withMessages;

  return [
    ...head,
    list,
    '',
    '_Full commit messages omitted — they exceed the comment size budget._',
  ].join('\n');
};
