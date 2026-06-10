// Pure rendering for the PR commit-summary bot comment: a compact commit list
// plus an expandable section with each full commit message. The git invocation
// lives in render-commits.ts; everything here is testable without git.

import { shortSha } from './render/format';

/** Marker the comment publisher uses to find/replace this comment. */
export const COMMITS_COMMENT_MARKER = '<!-- pr-commits-comment -->';

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

const renderFullMessage = (entry: CommitEntry): string => {
  const fence = fenceFor(entry.message);
  return [
    `#### \`${shortSha(entry.sha)}\` ${entry.subject}`,
    '',
    `${fence}text`,
    entry.message,
    fence,
  ].join('\n');
};

// GitHub rejects issue/PR comment bodies over 65,536 characters with a 422, so
// the full-message section is dropped before a long-lived branch hits that cap.
const GITHUB_COMMENT_LIMIT = 65_536;

const commitListLines = (entries: readonly CommitEntry[]): string[] =>
  entries.map((entry) => `- \`${shortSha(entry.sha)}\` ${entry.subject}`);

const fullMessagesLines = (entries: readonly CommitEntry[]): string[] => [
  '',
  '<details>',
  '<summary>Full commit messages</summary>',
  '',
  entries.map(renderFullMessage).join('\n\n'),
  '',
  '</details>',
];

const composeCommitsComment = (head: readonly string[], body: readonly string[]): string =>
  [...head, ...body, '', COMMITS_COMMENT_MARKER].join('\n');

/**
 * Render the commit-summary comment markdown (base..head, oldest first).
 * // Usage: renderCommitsComment(entries, { baseSha, headSha })
 */
export const renderCommitsComment = (
  entries: readonly CommitEntry[],
  range: { baseSha: string; headSha: string }
): string => {
  const count = entries.length;
  const head = [
    `## Commits — ${count} commit${count === 1 ? '' : 's'}`,
    '',
    `Base \`${shortSha(range.baseSha)}\` → head \`${shortSha(range.headSha)}\`, oldest first.`,
    '',
  ];

  if (count === 0) {
    return composeCommitsComment(head, ['_No commits between base and head._']);
  }

  const list = commitListLines(entries);
  const withMessages = composeCommitsComment(head, [...list, ...fullMessagesLines(entries)]);
  if (withMessages.length <= GITHUB_COMMENT_LIMIT) return withMessages;

  return composeCommitsComment(head, [
    ...list,
    '',
    "_Full commit messages omitted — they exceed GitHub's comment size limit._",
  ]);
};
