import { describe, expect, it } from 'bun:test';

import {
  RulesSyntaxError,
  tokenizeRules,
} from '../../../../src/modules/library/infrastructure/settings-parsers/starlark-tokens';

describe('tokenizeRules', () => {
  it('emits a newline token only where a statement can end', () => {
    const kinds = tokenizeRules('f(\n  a,\n)\ng()').map((token) => token.kind);
    expect(kinds).toEqual([
      'word',
      'punct',
      'word',
      'punct',
      'punct',
      'newline',
      'word',
      'punct',
      'punct',
    ]);
  });

  it('records the line each token starts on, including after a multi-line string', () => {
    const tokens = tokenizeRules('a = """x\ny"""\nb');
    expect(tokens.map((token) => [token.kind, token.line])).toEqual([
      ['word', 1],
      ['punct', 1],
      ['string', 1],
      ['newline', 2],
      ['word', 3],
    ]);
  });

  it('decodes escapes in ordinary strings and keeps them in raw strings', () => {
    const [plain, raw] = tokenizeRules('"a\\"b\\n" r"c\\d"');
    expect(plain).toMatchObject({ kind: 'string', value: 'a"b\n' });
    expect(raw).toMatchObject({ kind: 'string', value: 'c\\d' });
  });

  it('ignores a comment to the end of its line but keeps a # inside a string', () => {
    const tokens = tokenizeRules('"#a" # tail "x"');
    expect(tokens).toEqual([{ kind: 'string', value: '#a', line: 1 }]);
  });

  it('joins lines after a backslash continuation', () => {
    const kinds = tokenizeRules('a \\\n b').map((token) => token.kind);
    expect(kinds).toEqual(['word', 'word']);
  });

  it.each([
    ['an unterminated string', '"abc', 'line 1: unterminated string'],
    ['a string that runs past its line', '"abc\n"', 'line 1: unterminated string'],
    ['an unclosed bracket', 'f(\n[', "line 2: ']' expected to close a bracket"],
    ['a stray closer', 'a)', "line 1: unexpected ')'"],
    ['mismatched brackets', 'f(]', "line 1: unexpected ']'"],
  ])('rejects %s with a located error', (_label, source, message) => {
    expect(() => tokenizeRules(source)).toThrow(message);
    expect(() => tokenizeRules(source)).toThrow(RulesSyntaxError);
  });
});
