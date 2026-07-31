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

function isBlockedIPv4Number(num: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([network, mask]) => (num & mask) === (network & mask));
}

function isBlockedIPv4(ip: string): boolean {
  return isBlockedIPv4Number(ipv4ToNumber(ip));
}

/** A dotted quad as a 32-bit number, or null when it is not one. */
function parseIPv4Literal(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    num = num * 256 + octet;
  }
  return num;
}

/** The eight 16-bit groups of a run of IPv6 text, or null if it is malformed. */
function parseHextets(text: string): number[] | null {
  if (text === '') return [];

  const parts = text.split(':');
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    // A dotted quad stands for the final two groups, so it is only legal last.
    if (part.includes('.')) {
      if (index !== parts.length - 1) return null;
      const num = parseIPv4Literal(part);
      if (num === null) return null;
      groups.push(num >>> 16, num & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/**
 * Expands an IPv6 address into its eight 16-bit groups, or null when it cannot
 * be read as one.
 *
 * Classifying v6 on the text of the address does not work, because the text is
 * not stable: `new URL('https://[::ffff:127.0.0.1]')` reports its hostname as
 * `[::ffff:7f00:1]`, so a blocklist written against the dotted form never sees
 * the address it was written for. Every check here therefore runs on the bits.
 */
function parseIPv6(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = parseHextets(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parseHextets(halves[1]);
  if (tail === null) return null;

  const elided = 8 - head.length - tail.length;
  if (elided < 1) return null;
  return [...head, ...Array<number>(elided).fill(0), ...tail];
}

/**
 * The IPv4 address carried in the low 32 bits of a v4-mapped (`::ffff:0:0/96`)
 * or v4-compatible (`::/96`) address, or null when there is none.
 *
 * Both forms reach the IPv4 host they name, so both have to be handed to the
 * IPv4 blocklist rather than judged as ordinary v6. `::1` and `::` fall in here
 * too, as `0.0.0.1` and `0.0.0.0` — which `0.0.0.0/8` already covers.
 */
function embeddedIPv4(groups: readonly number[]): number | null {
  if (groups[0] !== 0 || groups[1] !== 0 || groups[2] !== 0 || groups[3] !== 0) return null;
  if (groups[4] !== 0) return null;
  if (groups[5] !== 0 && groups[5] !== 0xffff) return null;
  return ((groups[6] << 16) | groups[7]) >>> 0;
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
  const groups = parseIPv6(ip.toLowerCase().split('%')[0]);
  // An address this module cannot read is one it cannot vouch for. Every form a
  // URL parser or a resolver actually hands us parses, so refusing the rest
  // costs nothing real and keeps an unreadable address out of the public path.
  if (groups === null) return true;

  const embedded = embeddedIPv4(groups);
  if (embedded !== null) return isBlockedIPv4Number(embedded);

  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 — link local
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
