import { describe, expect, it } from 'bun:test';
import { parseCommitMessageOutput } from '../../src/git';

describe('parseCommitMessageOutput', () => {
  it('parses labelled output and removes title punctuation wrappers', () => {
    expect(
      parseCommitMessageOutput(`
Title: \`feat(git): generate commit messages.\`

Body:
Build the message from the selected worktree diff.
`)
    ).toEqual({
      title: 'feat(git): generate commit messages',
      body: 'Build the message from the selected worktree diff.',
    });
  });

  it('tolerates fenced output and quoted titles', () => {
    expect(
      parseCommitMessageOutput(`\`\`\`text
"Fix generated commit titles."

Keep the form editable after generation.
\`\`\``)
    ).toEqual({
      title: 'Fix generated commit titles',
      body: 'Keep the form editable after generation.',
    });
  });

  it('caps titles at 72 characters and preserves a trimmed body', () => {
    const parsed = parseCommitMessageOutput(`${'a'.repeat(90)}\n\n  Body text.  `);
    expect(parsed.title).toBe('a'.repeat(72));
    expect(parsed.body).toBe('Body text.');
  });

  it('keeps unmatched wrapper characters that belong to the title', () => {
    expect(parseCommitMessageOutput('`git log` output is no longer truncated').title).toBe(
      '`git log` output is no longer truncated'
    );
  });

  it('strips punctuation left at the clip boundary of a long title', () => {
    expect(parseCommitMessageOutput(`${'a'.repeat(71)}.tail`).title).toBe('a'.repeat(71));
  });

  it('returns an empty title for blank model output', () => {
    expect(parseCommitMessageOutput('  \n```\n')).toEqual({ title: '', body: '' });
  });
});
