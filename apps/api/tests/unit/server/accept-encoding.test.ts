import { describe, expect, test } from 'bun:test';
import {
  type EncodingChoice,
  negotiateEncoding,
  varyOnAcceptEncoding,
} from '../../../src/server/accept-encoding';

const BOTH = ['br', 'gzip'] as const;

describe('negotiateEncoding', () => {
  test.each<[string, string | null, EncodingChoice]>([
    ['no header', null, 'identity'],
    ['an empty header', '', 'identity'],
    ['identity alone', 'identity', 'identity'],
    ['gzip alone', 'gzip', 'gzip'],
    ['br alone', 'br', 'br'],
    ['a tie between both', 'gzip, br', 'br'],
    ['a tie with explicit weights', 'gzip;q=1, br;q=1.0', 'br'],
    ['a higher gzip weight', 'br;q=0.4, gzip;q=0.8', 'gzip'],
    ['a refused br', 'br;q=0, gzip', 'gzip'],
    ['a refused br and gzip', 'br;q=0, gzip;q=0', 'identity'],
    ['a wildcard', '*', 'br'],
    ['a wildcard with a refused coding', '*, br;q=0', 'gzip'],
    ['a weighted wildcard', '*;q=0.3, gzip;q=0.1', 'br'],
    ['an unsupported coding only', 'zstd, deflate', 'identity'],
    ['an unsupported coding beside gzip', 'zstd, gzip', 'gzip'],
    ['mixed case and padding', ' GZip ; Q=0.5 ', 'gzip'],
    ['the x-gzip alias', 'x-gzip', 'gzip'],
    ['an implicit identity that never outranks a requested coding', 'gzip;q=0.1', 'gzip'],
    ['an explicit identity weighted above gzip', 'identity;q=0.9, gzip;q=0.5', 'identity'],
    ['an explicit identity weighted below gzip', 'identity;q=0.2, gzip;q=0.5', 'gzip'],
    ['an identity tie, which the coding wins', 'identity, gzip', 'gzip'],
    ['identity refused, a coding named', 'identity;q=0, gzip', 'gzip'],
    ['identity refused, nothing else named', 'identity;q=0', null],
    ['a refused wildcard', '*;q=0', null],
    ['a refused wildcard with a coding named', '*;q=0, br', 'br'],
    ['a refused wildcard with identity named', '*;q=0, identity', 'identity'],
    ['a refused identity beside an unsupported coding', 'identity;q=0, deflate', null],
    ['a malformed weight, ignored', 'gzip;q=banana', 'identity'],
    ['a weight above 1, ignored', 'br;q=1.5, gzip', 'gzip'],
    ['a weight with too many decimals, ignored', 'br;q=0.12345, gzip', 'gzip'],
    ['a bare separator', ',,;,', 'identity'],
    ['a coding listed twice keeps its first weight', 'gzip;q=0, gzip', 'identity'],
  ])('resolves %s', (_label, header, expected) => {
    expect(negotiateEncoding(header, BOTH)).toBe(expected);
  });

  test('only offers codings that exist for the resource', () => {
    expect(negotiateEncoding('br, gzip', ['gzip'])).toBe('gzip');
    expect(negotiateEncoding('br', ['gzip'])).toBe('identity');
    expect(negotiateEncoding('*', ['br'])).toBe('br');
    expect(negotiateEncoding('identity;q=0, br', ['gzip'])).toBeNull();
  });
});

describe('varyOnAcceptEncoding', () => {
  test('sets Vary when nothing is there yet', () => {
    const headers: Record<string, unknown> = {};
    varyOnAcceptEncoding(headers);

    expect(headers).toEqual({ Vary: 'Accept-Encoding' });
  });

  test('keeps an existing directive, whatever the key casing', () => {
    const headers: Record<string, unknown> = { vary: 'Origin' };
    varyOnAcceptEncoding(headers);

    expect(headers).toEqual({ vary: 'Origin, Accept-Encoding' });
  });

  test('folds an array-valued Vary into one header', () => {
    const headers: Record<string, unknown> = { Vary: ['Origin', 'Accept'] };
    varyOnAcceptEncoding(headers);

    expect(headers).toEqual({ Vary: 'Origin, Accept, Accept-Encoding' });
  });

  test.each(['Accept-Encoding', 'origin, accept-encoding', '*'])(
    'leaves %p alone, since it already covers the header',
    (existing) => {
      const headers: Record<string, unknown> = { Vary: existing };
      varyOnAcceptEncoding(headers);

      expect(headers).toEqual({ Vary: existing });
    }
  );
});
