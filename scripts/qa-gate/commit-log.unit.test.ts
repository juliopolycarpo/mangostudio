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
    expect(section).not.toContain('Full commit messages</summary>');
    expect(section).toContain('Full commit messages omitted');
    expect(section).toContain('- `0000000` commit 0');
  });

  describe('fold threshold', () => {
    const commits = (count: number): CommitEntry[] =>
      Array.from({ length: count }, (_, index) => ({
        sha: `${index + 1}`.padStart(7, '0') + 'a'.repeat(33),
        subject: `feat: commit ${index + 1}`,
        // A multi-line body must not add to the count.
        message: `feat: commit ${index + 1}\n\n- body bullet\n- another bullet`,
      }));
    const listFolded = (section: string): boolean => section.includes('<summary>');
    const listSummary = (count: number): string => `<summary>${count} commits</summary>`;

    it.each([1, 5])('keeps %d commits expanded in place', (count) => {
      const section = renderCommitsSection(commits(count), RANGE);

      expect(section).not.toContain(listSummary(count));
      expect(section).toContain(`- \`${`${count}`.padStart(7, '0')}\` feat: commit ${count}`);
      expect(section).toContain(`## Commits — ${count} commit`);
    });

    it.each([6, 12])('folds %d commits behind a summary naming the real count', (count) => {
      const section = renderCommitsSection(commits(count), RANGE);

      expect(section).toContain(listSummary(count));
      const foldedList = section.slice(
        section.indexOf(listSummary(count)),
        section.indexOf('</details>')
      );
      expect(foldedList.split('\n').filter((line) => line.startsWith('- `'))).toHaveLength(count);
      // Heading and range stay visible above the fold.
      expect(section.indexOf('## Commits')).toBeLessThan(section.indexOf('<details>'));
    });

    it('keeps the full-message block collapsed independently of the list', () => {
      const small = renderCommitsSection(commits(2), RANGE);

      expect(listFolded(small)).toBe(true);
      expect(small).toContain('<summary>Full commit messages</summary>');
      expect(small).not.toContain('2 commits</summary>');
    });

    it('still folds the list when the full messages are dropped for size', () => {
      const section = renderCommitsSection(commits(8), RANGE, 100);

      expect(section).toContain(listSummary(8));
      expect(section).toContain('Full commit messages omitted');
    });
  });

  it('escapes HTML in subjects so a marker or tag cannot render as markup', () => {
    const hostile: CommitEntry = {
      sha: 'eeee555eeee555eeee555eeee555eeee555eeee5',
      subject: 'fix: <!-- qa-gate-metrics-comment --> & <script>',
      message: 'fix: <!-- qa-gate-metrics-comment --> & <script>\n\nbody -> ok',
    };

    const section = renderCommitsSection([hostile], RANGE);

    expect(section).toContain(
      '- `eeee555` fix: &lt;!-- qa-gate-metrics-comment --&gt; &amp; &lt;script&gt;'
    );
    expect(section).toContain(
      '#### `eeee555` fix: &lt;!-- qa-gate-metrics-comment --&gt; &amp; &lt;script&gt;'
    );
    // Inside the fence the message stays verbatim: HTML is literal there.
    expect(section).toContain('\nfix: <!-- qa-gate-metrics-comment --> & <script>\n\nbody -> ok\n');
    const outsideFence = section.replace(/(`{4,})text[\s\S]*?\1/g, '');
    expect(outsideFence).not.toContain('<!--');
    expect(outsideFence).not.toContain('<script>');
  });

  it('keeps backticks in a subject from opening a code span in the list or heading', () => {
    const ticky: CommitEntry = {
      sha: 'ffff666ffff666ffff666ffff666ffff666ffff6',
      subject: 'fix: `<T>` and ``x`` and a stray ` plus C:\\`',
      message: 'fix: body',
    };

    const section = renderCommitsSection([ticky], RANGE);

    const escaped = 'fix: \\`&lt;T&gt;\\` and \\`\\`x\\`\\` and a stray \\` plus C:\\\\\\`';
    expect(section).toContain(`- \`ffff666\` ${escaped}`);
    expect(section).toContain(`#### \`ffff666\` ${escaped}`);
    // Only the two sha spans and the two range spans may remain as code spans.
    const withoutFence = section.replace(/(`{4,})text[\s\S]*?\1/g, '');
    const unescapedTicks = withoutFence.match(/(?<!\\)`/g) ?? [];
    expect(unescapedTicks).toHaveLength(8);
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
