import { describe, expect, it } from 'bun:test';

import { escapeBackticks } from './format';

describe('escapeBackticks', () => {
  it('leaves text without backticks or backslashes untouched', () => {
    expect(escapeBackticks('feat(api): add thing')).toBe('feat(api): add thing');
  });

  it('escapes every backtick of a run so none can open a code span', () => {
    expect(escapeBackticks('use `a` and ``b``')).toBe('use \\`a\\` and \\`\\`b\\`\\`');
  });

  it('escapes a backslash first so it cannot cancel the escape of the backtick after it', () => {
    expect(escapeBackticks('C:\\`')).toBe('C:\\\\\\`');
  });
});
