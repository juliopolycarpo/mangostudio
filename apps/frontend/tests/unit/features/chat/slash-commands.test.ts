/**
 * The `/` palette's rules, away from a rendered composer.
 *
 * Two of them are load-bearing and neither is obvious from the UI: only a
 * leading slash is a command, and the caret decides whether the user is still
 * naming one or has moved on to its arguments.
 */

import { describe, expect, it } from 'bun:test';
import {
  applySlashCompletion,
  matchSlashCommands,
  mergeSlashCommands,
  nextSlashIndex,
  type SlashCommandEntry,
  slashQueryAt,
} from '@/features/chat/lib/slash-commands';

function entry(
  name: string,
  origin: SlashCommandEntry['origin'] = 'session',
  description?: string
): SlashCommandEntry {
  return { name, origin, ...(description ? { description } : {}) };
}

describe('slashQueryAt', () => {
  it('opens on a bare slash with an empty query, which matches everything', () => {
    expect(slashQueryAt('/', 1)).toBe('');
  });

  it('returns the partial name the caret is inside', () => {
    expect(slashQueryAt('/rev', 4)).toBe('rev');
    expect(slashQueryAt('/review', 3)).toBe('review');
  });

  /**
   * Neither CLI expands a slash that is not the first character, so completing
   * one would insert a name the agent reads as ordinary prose.
   */
  it('stays closed when the slash is not the first character', () => {
    expect(slashQueryAt('fix the /review flow', 15)).toBeNull();
    expect(slashQueryAt(' /review', 8)).toBeNull();
  });

  it('closes once the caret has moved into the arguments', () => {
    expect(slashQueryAt('/review src/', 12)).toBeNull();
    expect(slashQueryAt('/review src/', 7)).toBe('review');
  });

  it('stays closed on text with no slash at all', () => {
    expect(slashQueryAt('review this', 6)).toBeNull();
  });

  /**
   * An absolute path is a common opening token here, and no vendor command
   * name contains a separator — Claude Code namespaces plugin commands with
   * `:`, Cursor uses plain names. Without this the palette sits open over every
   * path a user pastes into an empty composer.
   */
  it('treats a leading path as prose rather than a command', () => {
    expect(slashQueryAt('/home/me/repo is broken', 5)).toBeNull();
    expect(slashQueryAt('/usr/bin/env', 12)).toBeNull();
  });
});

describe('applySlashCompletion', () => {
  it('completes a bare name and leaves the caret past a trailing space', () => {
    expect(applySlashCompletion('/rev', 'review')).toEqual({
      value: '/review ',
      caret: '/review '.length,
    });
  });

  it('keeps arguments that were already typed', () => {
    expect(applySlashCompletion('/rev --all', 'review')).toEqual({
      value: '/review --all',
      caret: '/review '.length,
    });
  });

  it('replaces a name that was typed in full', () => {
    expect(applySlashCompletion('/review', 'review-pr')).toEqual({
      value: '/review-pr ',
      caret: '/review-pr '.length,
    });
  });

  /**
   * The caret is a position in the completed string, not `name.length + 2`: a
   * separator the user wrote rather than the completion is left in front of it,
   * or the caret lands on the next line instead of after the command.
   */
  it('stops at the command when the separator is not a single space', () => {
    expect(applySlashCompletion('/rev\nnotes', 'review')).toEqual({
      value: '/review\nnotes',
      caret: '/review'.length,
    });
    expect(applySlashCompletion('/rev  --all', 'review')).toEqual({
      value: '/review  --all',
      caret: '/review'.length,
    });
  });
});

describe('mergeSlashCommands', () => {
  /**
   * The session's list wins a name outright. A command that propagated
   * correctly is in both sources, and showing it twice is exactly what the
   * library is built to produce.
   */
  it('keeps the first source that claims a name', () => {
    const merged = mergeSlashCommands(
      [entry('review', 'session', 'from the running agent')],
      [entry('review', 'library'), entry('deploy', 'library')]
    );

    expect(merged).toEqual([
      { name: 'review', origin: 'session', description: 'from the running agent' },
      { name: 'deploy', origin: 'library' },
    ]);
  });

  it('drops blank names and trims the rest', () => {
    expect(mergeSlashCommands([entry('  '), entry(' review ')])).toEqual([
      { name: 'review', origin: 'session' },
    ]);
  });
});

describe('matchSlashCommands', () => {
  const entries = [
    entry('deploy', 'session', 'Ship the build'),
    entry('review', 'session', 'Read a diff'),
    entry('pr-review', 'library'),
  ];

  it('returns everything for an empty query', () => {
    expect(matchSlashCommands(entries, '')).toEqual(entries);
  });

  /**
   * Catalogs arrive in the vendor's own order, so a longer name can precede the
   * one it extends. Enter completes the top row: without an exact tier, a user
   * who typed `/test` in full gets `/test-all`, a different command.
   */
  it('puts a name typed in full ahead of a longer one that starts with it', () => {
    const ordered = [entry('test-all'), entry('test')];
    expect(matchSlashCommands(ordered, 'test').map((match) => match.name)).toEqual([
      'test',
      'test-all',
    ]);
  });

  it('ranks a prefix match above a name that merely contains the query', () => {
    expect(matchSlashCommands(entries, 'review').map((match) => match.name)).toEqual([
      'review',
      'pr-review',
    ]);
  });

  it('finds a command by what its description says it does', () => {
    expect(matchSlashCommands(entries, 'ship').map((match) => match.name)).toEqual(['deploy']);
  });

  it('is case-insensitive', () => {
    expect(matchSlashCommands(entries, 'REV').map((match) => match.name)).toEqual([
      'review',
      'pr-review',
    ]);
  });

  it('honours the row limit', () => {
    expect(matchSlashCommands(entries, '', 2)).toHaveLength(2);
  });
});

describe('nextSlashIndex', () => {
  it('wraps at both ends so the list is a loop', () => {
    expect(nextSlashIndex(2, 3, 1)).toBe(0);
    expect(nextSlashIndex(0, 3, -1)).toBe(2);
  });

  it('stays at zero when there is nothing to walk', () => {
    expect(nextSlashIndex(0, 0, 1)).toBe(0);
  });
});
