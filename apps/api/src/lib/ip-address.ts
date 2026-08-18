/**
 * One normalisation, then policy questions on top of it. `apps/api` used to answer
 * "is this address local or private?" in three separate places (a CLI health probe,
 * the outbound-request SSRF guard, and the environment install guard), each with its
 * own parsing rules — bracketed IPv6, zone ids, trailing dots and `::ffff:`-mapped
 * IPv4 were each handled in at most one of the three. An address form that is
 * mis-parsed is now mis-parsed in exactly one place.
 *
 * A bare short form like `127.1` is rejected rather than expanded to `127.0.0.1`:
 * every caller before this module required exactly four dot-separated octets, so
 * rejecting keeps behaviour unchanged rather than silently accepting a new form.
 */

export type ParsedAddress =
  | { readonly family: 4; readonly octets: readonly [number, number, number, number] }
  | { readonly family: 6; readonly groups: readonly number[] }
  | null;

/** Strips bracket, zone id and one trailing dot; does not touch case. */
function normalize(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = withoutBrackets.split('%', 1)[0] ?? withoutBrackets;
  return withoutZone.length > 1 && withoutZone.endsWith('.')
    ? withoutZone.slice(0, -1)
    : withoutZone;
}

/** A dotted quad as four octets, or null when it is not a well-formed one. */
function parseIPv4Literal(text: string): readonly [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets as [number, number, number, number];
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
      const octets = parseIPv4Literal(part);
      if (octets === null) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/**
 * Expands an IPv6 address into its eight 16-bit groups, or null when it cannot be
 * read as one. Classifying v6 on the text of the address does not work, because the
 * text is not stable (`new URL('https://[::ffff:127.0.0.1]')` reports its hostname
 * as `[::ffff:7f00:1]`), so every check downstream runs on these groups, not on text.
 */
function parseIPv6(text: string): readonly number[] | null {
  const halves = text.split('::');
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

/** Parses a loopback, private-range or public address in any of the forms above. */
export function parseIpAddress(value: string): ParsedAddress {
  const normalized = normalize(value);

  const octets = parseIPv4Literal(normalized);
  if (octets !== null) return { family: 4, octets };

  const groups = parseIPv6(normalized);
  if (groups !== null) return { family: 6, groups };

  return null;
}

/**
 * The IPv4 address carried in the low 32 bits of a v4-mapped (`::ffff:0:0/96`) or
 * v4-compatible (`::/96`) address, or null when there is none. Both forms reach the
 * IPv4 host they name, so both are handed to the IPv4 rules rather than judged as
 * ordinary v6. `::1` and `::` fall in here too, as `0.0.0.1` and `0.0.0.0`.
 */
function embeddedIPv4(groups: readonly number[]): readonly [number, number, number, number] | null {
  if (groups[0] !== 0 || groups[1] !== 0 || groups[2] !== 0 || groups[3] !== 0) return null;
  if (groups[4] !== 0) return null;
  if (groups[5] !== 0 && groups[5] !== 0xffff) return null;
  return [groups[6] >>> 8, groups[6] & 0xff, groups[7] >>> 8, groups[7] & 0xff];
}

function isIPv6Loopback(groups: readonly number[]): boolean {
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

// fe80::/10 spans fe80 through febf, so a prefix-string test would let fe81::1
// through; unique-local fc00::/7 has no distinctive text prefix at all, since it
// covers both fc.. and fd... Both are matched on the leading bits instead.
function isUniqueLocalIPv6(groups: readonly number[]): boolean {
  return (groups[0] & 0xfe00) === 0xfc00;
}

function isLinkLocalIPv6(groups: readonly number[]): boolean {
  return (groups[0] & 0xffc0) === 0xfe80;
}

function ipv4Range(a: number, b: number, c: number, d: number, prefixBits: number) {
  const network = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
  return [network & mask, mask] as const;
}

/** Ranges that must never be reached by outbound requests or counted as public. */
const PRIVATE_OR_LOCAL_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  ipv4Range(127, 0, 0, 0, 8), // loopback
  ipv4Range(10, 0, 0, 0, 8), // RFC1918
  ipv4Range(172, 16, 0, 0, 12), // RFC1918
  ipv4Range(192, 168, 0, 0, 16), // RFC1918
  ipv4Range(169, 254, 0, 0, 16), // link-local
  ipv4Range(100, 64, 0, 0, 10), // CGNAT (RFC 6598)
  ipv4Range(0, 0, 0, 0, 8), // "this network" / unspecified
];

function isPrivateOrLocalIPv4(octets: readonly [number, number, number, number]): boolean {
  const num = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return PRIVATE_OR_LOCAL_IPV4_RANGES.some(([network, mask]) => (num & mask) === network);
}

/** True for `localhost` and any address in the 127.0.0.0/8 or `::1` loopback ranges. */
export function isLoopback(value: string): boolean {
  const normalized = normalize(value);
  if (normalized === 'localhost') return true;

  const parsed = parseIpAddress(normalized);
  if (parsed === null) return false;
  if (parsed.family === 4) return parsed.octets[0] === 127;

  if (isIPv6Loopback(parsed.groups)) return true;
  const embedded = embeddedIPv4(parsed.groups);
  return embedded !== null && embedded[0] === 127;
}

/**
 * True for `localhost`, loopback, RFC1918, link-local and CGNAT addresses, and for
 * any address this module cannot parse. An address it cannot read is one it cannot
 * vouch for, and every form a URL parser or a resolver actually hands us parses —
 * so refusing the rest costs nothing real and keeps an unreadable address out of
 * the public path.
 */
export function isPrivateOrLocal(value: string): boolean {
  const normalized = normalize(value);
  if (normalized === 'localhost') return true;

  const parsed = parseIpAddress(normalized);
  if (parsed === null) return true;
  if (parsed.family === 4) return isPrivateOrLocalIPv4(parsed.octets);

  const embedded = embeddedIPv4(parsed.groups);
  if (embedded !== null) return isPrivateOrLocalIPv4(embedded);
  return isUniqueLocalIPv6(parsed.groups) || isLinkLocalIPv6(parsed.groups);
}
