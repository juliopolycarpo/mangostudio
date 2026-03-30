/**
 * Validates provider base URLs to prevent SSRF attacks.
 * Rejects loopback, RFC1918 private, and link-local addresses.
 */

import { lookup } from 'dns/promises';

/** Ranges that must never be reached by outbound provider requests. */
const BLOCKED_IPV4_RANGES: [number, number, number][] = [
  // [network, mask, bits] — network & mask must match first `bits` of target
  ...ipv4Range('127.0.0.0', 8),
  ...ipv4Range('10.0.0.0', 8),
  ...ipv4Range('172.16.0.0', 12),
  ...ipv4Range('192.168.0.0', 16),
  ...ipv4Range('169.254.0.0', 16),
  ...ipv4Range('0.0.0.0', 8),
];

function ipv4Range(base: string, prefix: number): [number, number, number][] {
  const num = ipv4ToNumber(base);
  const mask = (~0 << (32 - prefix)) >>> 0;
  return [[num, mask, prefix]];
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedIPv4(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  return BLOCKED_IPV4_RANGES.some(([network, mask]) => (num & mask) === (network & mask));
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80')) return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) return isBlockedIPv4(v4Match[1]);
  return false;
}

export class UnsafeBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBaseUrlError';
  }
}

/**
 * Validates a base URL for outbound provider requests.
 * Rejects non-http(s) schemes and hostnames that resolve to private/loopback addresses.
 *
 * @throws {UnsafeBaseUrlError} if the URL is unsafe.
 */
export async function validateBaseUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeBaseUrlError('Invalid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeBaseUrlError('Only http and https URLs are allowed.');
  }

  const hostname = parsed.hostname;

  // Direct IPv4 literal check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
    }
    return;
  }

  // Direct IPv6 literal check (brackets kept by URL parser)
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bare = hostname.slice(1, -1);
    if (isBlockedIPv6(bare)) {
      throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
    }
    return;
  }

  // DNS resolution check
  try {
    const results = await lookup(hostname, { all: true });
    for (const result of results) {
      if (result.family === 4 && isBlockedIPv4(result.address)) {
        throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
      }
      if (result.family === 6 && isBlockedIPv6(result.address)) {
        throw new UnsafeBaseUrlError('URL resolves to a blocked private or loopback address.');
      }
    }
  } catch (err) {
    if (err instanceof UnsafeBaseUrlError) throw err;
    throw new UnsafeBaseUrlError(`DNS resolution failed for hostname "${hostname}".`);
  }
}
