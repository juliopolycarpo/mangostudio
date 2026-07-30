/**
 * Validates outbound URLs to prevent SSRF attacks.
 * Rejects loopback, RFC1918 private, unique-local, and link-local addresses.
 */

import { lookup } from 'node:dns/promises';

type AddressFamily = 4 | 6;
type ResolvedAddress = Readonly<{ address: string; family: AddressFamily }>;
type HostResolver = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;

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

/**
 * First 16-bit group of an IPv6 address, or null when it cannot be read.
 *
 * An address that starts with `::` has a zero first group by definition, which
 * is why the leading-`::` case is answered before any parsing.
 */
function firstHextet(ip: string): number | null {
  if (ip.startsWith('::')) return 0;
  const group = ip.split(':', 1)[0];
  if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  return Number.parseInt(group, 16);
}

/**
 * Blocked v6 ranges are matched on the leading bits rather than on the text of
 * the address. `fe80::/10` spans `fe80` through `febf`, so a prefix-string test
 * lets `fe81::1` through — and unique-local `fc00::/7` has no distinctive text
 * prefix at all, since it covers both `fc..` and `fd..`.
 */
function isBlockedIPv6(ip: string): boolean {
  // A scope id (`fe80::1%eth0`) names an interface, not a host, and is not part
  // of the address being classified.
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::1' || normalized === '::') return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) return isBlockedIPv4(v4Match[1]);

  const leading = firstHextet(normalized);
  if (leading === null) return false;
  if ((leading & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local
  if ((leading & 0xffc0) === 0xfe80) return true; // fe80::/10 — link local
  return false;
}

export class UnsafeBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBaseUrlError';
  }
}

const hostnameResolutionCache = new Map<string, Promise<ReadonlyArray<ResolvedAddress>>>();

function resolveHostname(hostname: string): Promise<ReadonlyArray<ResolvedAddress>> {
  const cached = hostnameResolutionCache.get(hostname);
  if (cached) return cached;

  const pending = lookup(hostname, { all: true })
    .then((results) =>
      results.map((result) => ({
        address: result.address,
        family: result.family as AddressFamily,
      }))
    )
    .catch((error) => {
      hostnameResolutionCache.delete(hostname);
      throw error;
    });

  hostnameResolutionCache.set(hostname, pending);
  return pending;
}

export interface ValidateBaseUrlOptions {
  readonly resolveHostname?: HostResolver;
}

/**
 * Validates a base URL for outbound provider requests.
 * Rejects non-http(s) schemes and hostnames that resolve to private/loopback addresses.
 *
 * @throws {UnsafeBaseUrlError} if the URL is unsafe.
 */
export async function validateBaseUrl(
  rawUrl: string,
  options: ValidateBaseUrlOptions = {}
): Promise<void> {
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
    const results = await (options.resolveHostname ?? resolveHostname)(hostname);
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
