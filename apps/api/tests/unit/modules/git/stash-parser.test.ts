import { describe, expect, it } from 'bun:test';
import { parseStashList } from '../../../../src/modules/git/domain/stash-parser';

describe('parseStashList', () => {
  it('extracts indexes, branches, and messages from named and automatic stashes', () => {
    expect(
      parseStashList(
        'stash@{0}\0On feat/write: preserve panel work\n' +
          'stash@{1}\0WIP on main: 0123456 initial commit\n'
      )
    ).toEqual([
      { index: 0, branch: 'feat/write', message: 'preserve panel work' },
      { index: 1, branch: 'main', message: '0123456 initial commit' },
    ]);
  });

  it('keeps an unfamiliar subject as the message and ignores malformed selectors', () => {
    expect(parseStashList('stash@{3}\0custom subject\nnot-a-stash\0ignored\n')).toEqual([
      { index: 3, message: 'custom subject' },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseStashList('')).toEqual([]);
  });
});
