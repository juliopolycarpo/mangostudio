// Pure rendering for the PR commit-summary bot comment: a compact commit list
// plus an expandable section with each full commit message. The git invocation
// lives in render-commits.ts; everything here is testable without git.

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
    const [sha, subject, message] = trimmed.split(COMMIT_FIELD_SEPARATOR);
    if (!sha || subject === undefined || message === undefined) continue;
    entries.push({ sha: sha.trim(), subject, message: message.trimEnd() });
  }
  return entries;
};

const shortSha = (sha: string): string => sha.slice(0, 7);

// Four-backtick fence so commit bodies containing ``` cannot break out.
const renderFullMessage = (entry: CommitEntry): string =>
  [`#### \`${shortSha(entry.sha)}\` ${entry.subject}`, '', '````text', entry.message, '````'].join(
    '\n'
  );

/**
 * Render the commit-summary comment markdown (base..head, oldest first).
 * // Usage: renderCommitsComment(entries, { baseSha, headSha })
 */
export const renderCommitsComment = (
  entries: readonly CommitEntry[],
  range: { baseSha: string; headSha: string }
): string => {
  const count = entries.length;
  const heading = `## Commits — ${count} commit${count === 1 ? '' : 's'}`;
  const rangeLine = `Base \`${shortSha(range.baseSha)}\` → head \`${shortSha(range.headSha)}\`, oldest first.`;
  const lines: string[] = [heading, '', rangeLine, ''];

  if (count === 0) {
    lines.push('_No commits between base and head._');
  } else {
    lines.push(...entries.map((entry) => `- \`${shortSha(entry.sha)}\` ${entry.subject}`));
    lines.push(
      '',
      '<details>',
      '<summary>Full commit messages</summary>',
      '',
      entries.map(renderFullMessage).join('\n\n'),
      '',
      '</details>'
    );
  }

  lines.push('', COMMITS_COMMENT_MARKER);
  return lines.join('\n');
};
