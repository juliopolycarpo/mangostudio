import { describe, expect, it } from 'bun:test';

import {
  COMMIT_FIELD_SEPARATOR,
  COMMIT_RECORD_SEPARATOR,
  COMMITS_COMMENT_MARKER,
  type CommitEntry,
  parseCommitLog,
  renderCommitsComment,
} from './commit-log';

const RANGE = {
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  headSha: 'fedcba9876543210fedcba9876543210fedcba98',
};

const record = (sha: string, subject: string, message: string): string =>
  [sha, subject, message].join(COMMIT_FIELD_SEPARATOR) + COMMIT_RECORD_SEPARATOR;

describe('parseCommitLog', () => {
  it('parses multi-record git log output with multi-line bodies', () => {
    const raw = [
      record('aaaa111', 'feat(api): add thing', 'feat(api): add thing\n\nLong body\nwith lines.\n'),
      record('bbbb222', 'fix(ui): repair other', 'fix(ui): repair other\n'),
    ].join('\n');

    const entries = parseCommitLog(raw);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      sha: 'aaaa111',
      subject: 'feat(api): add thing',
      message: 'feat(api): add thing\n\nLong body\nwith lines.',
    });
    expect(entries[1]?.subject).toBe('fix(ui): repair other');
  });

  it('returns no entries for empty output', () => {
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog('\n')).toEqual([]);
  });
});

describe('renderCommitsComment', () => {
  const entries: CommitEntry[] = [
    {
      sha: 'aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1',
      subject: 'feat(api): add thing',
      message: 'feat(api): add thing\n\nLong body explaining why.',
    },
    {
      sha: 'bbbb222bbbb222bbbb222bbbb222bbbb222bbbb2',
      subject: 'fix(ui): repair other',
      message: 'fix(ui): repair other',
    },
  ];

  it('renders the list, expandable full messages, and the marker', () => {
    const comment = renderCommitsComment(entries, RANGE);

    expect(comment).toContain('## Commits — 2 commits');
    expect(comment).toContain('Base `0123456` → head `fedcba9`');
    expect(comment).toContain('- `aaaa111` feat(api): add thing');
    expect(comment).toContain('<summary>Full commit messages</summary>');
    expect(comment).toContain('#### `bbbb222` fix(ui): repair other');
    expect(comment).toContain('Long body explaining why.');
    expect(comment.trimEnd().endsWith(COMMITS_COMMENT_MARKER)).toBe(true);
  });

  it('renders a singular heading and an empty-range note', () => {
    const single = renderCommitsComment([entries[0] as CommitEntry], RANGE);
    expect(single).toContain('## Commits — 1 commit');

    const empty = renderCommitsComment([], RANGE);
    expect(empty).toContain('_No commits between base and head._');
    expect(empty).not.toContain('<details>');
    expect(empty).toContain(COMMITS_COMMENT_MARKER);
  });
});
