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
  const MAINTAINER = 'Maintainer <maintainer@example.test>';

  it('takes the first line as the title and drops the blank separator', () => {
    expect(
      splitCommitMessage('feat(git): amend from the panel\n\nExplain the change.\n', {})
    ).toEqual({ title: 'feat(git): amend from the panel', body: 'Explain the change.' });
  });

  it('keeps blank lines inside the body while trimming the leading ones', () => {
    expect(splitCommitMessage('title\n\n\nfirst paragraph\n\nsecond paragraph\n\n', {})).toEqual({
      title: 'title',
      body: 'first paragraph\n\nsecond paragraph',
    });
  });

  it('splits CRLF messages on the same boundaries', () => {
    expect(splitCommitMessage('title\r\n\r\nbody line\r\n', {})).toEqual({
      title: 'title',
      body: 'body line',
    });
  });

  it('removes the trailing sign-off only when the commit will re-add it', () => {
    const raw = `title\n\nExplain the change.\n\nSigned-off-by: ${MAINTAINER}\n`;

    expect(splitCommitMessage(raw, { signoffIdentity: MAINTAINER })).toEqual({
      title: 'title',
      body: 'Explain the change.',
    });
    expect(splitCommitMessage(raw, {})).toEqual({
      title: 'title',
      body: `Explain the change.\n\nSigned-off-by: ${MAINTAINER}`,
    });
  });

  it('keeps other signers when it removes the committer own trailer', () => {
    expect(
      splitCommitMessage(
        `title\n\nWhy it changed.\n\nSigned-off-by: Co Author <co@example.test>\nSigned-off-by: ${MAINTAINER}\n`,
        { signoffIdentity: MAINTAINER }
      )
    ).toEqual({
      title: 'title',
      body: 'Why it changed.\n\nSigned-off-by: Co Author <co@example.test>',
    });
  });

  it('removes the committer trailer from anywhere in the trailing block', () => {
    // Git only skips a duplicate when the identical trailer is already last, so
    // ours has to go even when a co-signer sits below it.
    expect(
      splitCommitMessage(
        `title\n\nSigned-off-by: ${MAINTAINER}\nSigned-off-by: Co Author <co@example.test>\n`,
        { signoffIdentity: MAINTAINER }
      )
    ).toEqual({ title: 'title', body: 'Signed-off-by: Co Author <co@example.test>' });
  });

  it('matches the committer trailer regardless of case and spacing', () => {
    expect(
      splitCommitMessage('title\n\nsigned-off-by:   MAINTAINER <MAINTAINER@example.test>  \n', {
        signoffIdentity: MAINTAINER,
      })
    ).toEqual({ title: 'title', body: '' });
  });

  it('returns an empty body for a subject-only commit', () => {
    expect(splitCommitMessage('subject only\n', { signoffIdentity: MAINTAINER })).toEqual({
      title: 'subject only',
      body: '',
    });
  });
});
