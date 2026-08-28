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
  slashCompletionCaret,
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
});

describe('applySlashCompletion', () => {
  it('completes a bare name and leaves the caret past a trailing space', () => {
    expect(applySlashCompletion('/rev', 'review')).toBe('/review ');
    expect(slashCompletionCaret('review')).toBe('/review '.length);
  });

  it('keeps arguments that were already typed', () => {
    expect(applySlashCompletion('/rev --all', 'review')).toBe('/review --all');
  });

  it('replaces a name that was typed in full', () => {
    expect(applySlashCompletion('/review', 'review-pr')).toBe('/review-pr ');
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
