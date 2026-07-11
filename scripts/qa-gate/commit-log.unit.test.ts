import { describe, expect, it } from 'bun:test';

import {
  COMMIT_FIELD_SEPARATOR,
  COMMIT_RECORD_SEPARATOR,
  type CommitEntry,
  parseCommitLog,
  renderCommitsSection,
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

  // %B is raw, so a body containing the field separator must not be truncated.
  it('preserves message content containing the field separator', () => {
    const raw = record(
      'cccc333',
      'chore: odd body',
      `chore: odd body\n\nweird${COMMIT_FIELD_SEPARATOR}payload\n`
    );

    const entries = parseCommitLog(raw);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe(`chore: odd body\n\nweird${COMMIT_FIELD_SEPARATOR}payload`);
  });
});

describe('renderCommitsSection', () => {
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

  it('renders the list and expandable full messages without any marker', () => {
    const section = renderCommitsSection(entries, RANGE);

    expect(section).toContain('## Commits — 2 commits');
    expect(section).toContain('Base `0123456` → head `fedcba9`');
    expect(section).toContain('- `aaaa111` feat(api): add thing');
    expect(section).toContain('<summary>Full commit messages</summary>');
    expect(section).toContain('#### `bbbb222` fix(ui): repair other');
    expect(section).toContain('Long body explaining why.');
    expect(section).not.toContain('<!--');
  });

  it('renders a singular heading and an empty-range note', () => {
    const single = renderCommitsSection([entries[0] as CommitEntry], RANGE);
    expect(single).toContain('## Commits — 1 commit');

    const empty = renderCommitsSection([], RANGE);
    expect(empty).toContain('_No commits between base and head._');
    expect(empty).not.toContain('<details>');
  });

  it('drops the full-message section when the body would exceed its budget', () => {
    const huge = 'x'.repeat(2_000);
    const many: CommitEntry[] = Array.from({ length: 40 }, (_, index) => ({
      sha: `${index}`.padStart(40, '0'),
      subject: `commit ${index}`,
      message: `commit ${index}\n\n${huge}`,
    }));

    const section = renderCommitsSection(many, RANGE);

    expect(section.length).toBeLessThanOrEqual(40_000);
    expect(section).not.toContain('<details>');
    expect(section).toContain('Full commit messages omitted');
    expect(section).toContain('- `0000000` commit 0');
  });

  it('sizes the fence past backtick runs inside the body', () => {
    const fencey: CommitEntry = {
      sha: 'dddd444dddd444dddd444dddd444dddd444dddd4',
      subject: 'docs: fence-heavy body',
      message: 'body with a fence:\n````\ninner\n````',
    };

    const section = renderCommitsSection([fencey], RANGE);

    expect(section).toContain('`````text');
    expect(section).toContain('\n`````\n');
  });
});
