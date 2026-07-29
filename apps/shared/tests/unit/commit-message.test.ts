import { describe, expect, it } from 'bun:test';
import { parseCommitMessageOutput, splitCommitMessage } from '../../src/git';

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

describe('splitCommitMessage', () => {
  it('takes the first line as the title and drops the blank separator', () => {
    expect(
      splitCommitMessage('feat(git): amend from the panel\n\nExplain the change.\n', {
        stripSignoff: false,
      })
    ).toEqual({ title: 'feat(git): amend from the panel', body: 'Explain the change.' });
  });

  it('keeps blank lines inside the body while trimming the leading ones', () => {
    expect(
      splitCommitMessage('title\n\n\nfirst paragraph\n\nsecond paragraph\n\n', {
        stripSignoff: false,
      })
    ).toEqual({ title: 'title', body: 'first paragraph\n\nsecond paragraph' });
  });

  it('splits CRLF messages on the same boundaries', () => {
    expect(splitCommitMessage('title\r\n\r\nbody line\r\n', { stripSignoff: false })).toEqual({
      title: 'title',
      body: 'body line',
    });
  });

  it('removes trailing sign-off trailers only when the setting asks for it', () => {
    const raw =
      'title\n\nExplain the change.\n\nSigned-off-by: Maintainer <maintainer@example.test>\n';

    expect(splitCommitMessage(raw, { stripSignoff: true })).toEqual({
      title: 'title',
      body: 'Explain the change.',
    });
    expect(splitCommitMessage(raw, { stripSignoff: false })).toEqual({
      title: 'title',
      body: 'Explain the change.\n\nSigned-off-by: Maintainer <maintainer@example.test>',
    });
  });

  it('removes every stacked sign-off trailer but keeps the prose above them', () => {
    expect(
      splitCommitMessage(
        'title\n\nWhy it changed.\n\nSigned-off-by: One <one@example.test>\nSigned-off-by: Two <two@example.test>\n',
        { stripSignoff: true }
      )
    ).toEqual({ title: 'title', body: 'Why it changed.' });
  });

  it('returns an empty body for a subject-only commit', () => {
    expect(splitCommitMessage('subject only\n', { stripSignoff: true })).toEqual({
      title: 'subject only',
      body: '',
    });
  });
});
