import { describe, expect, it } from 'bun:test';

import {
  expandCommandTemplate,
  parseSlashInvocation,
  splitCommandArguments,
} from '../../../../src/modules/library/domain/command-template';

describe('parseSlashInvocation', () => {
  it('splits the leading command name from its arguments', () => {
    expect(parseSlashInvocation('/review src/app.ts --strict')).toEqual({
      name: 'review',
      args: 'src/app.ts --strict',
    });
  });

  it('accepts a bare command with no arguments', () => {
    expect(parseSlashInvocation('/review')).toEqual({ name: 'review', args: '' });
  });

  it('keeps a multi-line argument block intact', () => {
    expect(parseSlashInvocation('/review first\nsecond')).toEqual({
      name: 'review',
      args: 'first\nsecond',
    });
  });

  it.each(['review it', ' /review', '/', '/ review', '/home/me/repo is broken', ''])(
    'returns null for a prompt that is not a command position: %j',
    (prompt) => {
      expect(parseSlashInvocation(prompt)).toBeNull();
    }
  );
});

describe('splitCommandArguments', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommandArguments(`one "two words" 'three words' four`)).toEqual([
      'one',
      'two words',
      'three words',
      'four',
    ]);
  });

  it('returns an empty list for blank arguments', () => {
    expect(splitCommandArguments('   ')).toEqual([]);
  });
});

describe('expandCommandTemplate', () => {
  it('substitutes $ARGUMENTS with the raw argument string', () => {
    expect(expandCommandTemplate('Review: $ARGUMENTS', 'a.ts "b c.ts"')).toBe(
      'Review: a.ts "b c.ts"'
    );
  });

  it('substitutes positional $1..$9 and leaves a missing position empty', () => {
    expect(expandCommandTemplate('first=$1 second=$2 third=$3', 'alpha "beta gamma"')).toBe(
      'first=alpha second=beta gamma third='
    );
  });

  it('does not re-scan substituted text for placeholders', () => {
    expect(expandCommandTemplate('Run $1 then $2', '$2 safe')).toBe('Run $2 then safe');
  });

  it('appends the arguments when the template has no placeholder', () => {
    expect(expandCommandTemplate('Summarize the diff.', 'only staged')).toBe(
      'Summarize the diff.\n\nARGUMENTS: only staged'
    );
  });

  it('leaves a placeholder-free template untouched when there are no arguments', () => {
    expect(expandCommandTemplate('Summarize the diff.', '')).toBe('Summarize the diff.');
  });

  it('replaces $ARGUMENTS with nothing when none were given', () => {
    expect(expandCommandTemplate('Go: $ARGUMENTS', '')).toBe('Go: ');
  });
});
