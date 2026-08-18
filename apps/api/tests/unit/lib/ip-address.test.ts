import { describe, expect, it } from 'bun:test';
import { isLoopback, isPrivateOrLocal, parseIpAddress } from '../../../src/lib/ip-address';
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
});
