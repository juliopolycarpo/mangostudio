import { describe, expect, it } from 'bun:test';
import {
  formatHostForUrl,
  isLoopback,
  isPrivateOrLocal,
  parseIpAddress,
} from '../../../src/lib/ip-address';
import { ADDRESS_FIXTURES } from './ip-address.fixtures';

describe('ip-address', () => {
  it.each(ADDRESS_FIXTURES)(
    'classifies $input as loopback=$loopback, privateOrLocal=$privateOrLocal',
    ({ input, loopback, privateOrLocal }) => {
      expect(isLoopback(input)).toBe(loopback);
      expect(isPrivateOrLocal(input)).toBe(privateOrLocal);
    }
  );

  it('treats "localhost" as loopback and private/local without parsing it as an IP', () => {
    expect(isLoopback('localhost')).toBe(true);
    expect(isPrivateOrLocal('localhost')).toBe(true);
    expect(parseIpAddress('localhost')).toBeNull();
  });

  it('rejects an address it cannot parse rather than treating it as public', () => {
    for (const value of ['not-an-address', '1:2:3:4:5:6:7:8:9', 'fe80::1::2', '::ffff:999.1.1.1']) {
      expect(parseIpAddress(value)).toBeNull();
      expect(isLoopback(value)).toBe(false);
      expect(isPrivateOrLocal(value)).toBe(true);
    }
  });

  it('parses a dotted quad into its octets', () => {
    expect(parseIpAddress('8.8.8.8')).toEqual({ family: 4, octets: [8, 8, 8, 8] });
  });

  it('parses IPv6 text into its eight 16-bit groups, expanding "::"', () => {
    expect(parseIpAddress('2001:db8::1')).toEqual({
      family: 6,
      groups: [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1],
    });
  });

  it('normalizes brackets, a zone id and a trailing dot before parsing', () => {
    expect(parseIpAddress('[::1]')).toEqual(parseIpAddress('::1'));
    expect(parseIpAddress('fe80::1%eth0')).toEqual(parseIpAddress('fe80::1'));
    expect(parseIpAddress('127.0.0.1.')).toEqual(parseIpAddress('127.0.0.1'));
  });

  it('reads a v4-mapped address by its bits, not by the text a URL parser rewrites it to', () => {
    // new URL('https://[::ffff:127.0.0.1]') reports its hostname as [::ffff:7f00:1] —
    // both spellings must classify identically.
    expect(isLoopback('::ffff:127.0.0.1')).toBe(isLoopback('::ffff:7f00:1'));
    expect(isPrivateOrLocal('::ffff:127.0.0.1')).toBe(isPrivateOrLocal('::ffff:7f00:1'));
  });

  it('blocks IPv6 link-local across the whole /10, not just the fe80 prefix', () => {
    for (const address of ['fe80::1', 'fe81::1', 'febf:ffff::1']) {
      expect(isPrivateOrLocal(address)).toBe(true);
    }
  });

  it('blocks IPv6 unique-local across both the fc.. and fd.. halves', () => {
    for (const address of ['fc00::1', 'fd12:3456:789a::1']) {
      expect(isPrivateOrLocal(address)).toBe(true);
    }
  });

  it('normalizes exactly once, so a doubled trailing dot stays unparseable', () => {
    // normalize() strips one trailing dot per pass, so running it twice would turn
    // `8.8.8.8..` into a public address. Every entry point must normalize once.
    expect(parseIpAddress('8.8.8.8..')).toBeNull();
    expect(isPrivateOrLocal('8.8.8.8..')).toBe(true);
    expect(isLoopback('127.0.0.1..')).toBe(false);
  });

  describe('formatHostForUrl', () => {
    it.each([
      ['127.0.0.1', '127.0.0.1'],
      ['127.0.0.1.', '127.0.0.1'],
      ['::1', '[::1]'],
      ['[::1]', '[::1]'],
      // A zone id names an interface, and `new URL` rejects it inside brackets.
      ['::1%lo0', '[::1]'],
      ['fe80::1%eth0', '[fe80::1]'],
      ['::ffff:127.0.0.1', '[::ffff:127.0.0.1]'],
      // Not an address: handed back normalized for the caller to reject.
      ['localhost', 'localhost'],
    ])('renders %s as %s', (input, expected) => {
      expect(formatHostForUrl(input)).toBe(expected);
    });

    it('renders every accepted loopback form into a URL that parses', () => {
      // The invariant health.ts depends on. Unparseable input (`256.1.1.1`) is handed
      // back as-is and is not a usable host — but isLoopback rejects it, so no caller
      // reaches a fetch with it.
      for (const { input } of ADDRESS_FIXTURES.filter((fixture) => fixture.loopback)) {
        expect(() => new URL(`http://${formatHostForUrl(input)}:3001/api/health`)).not.toThrow();
      }
    });
  });
});
