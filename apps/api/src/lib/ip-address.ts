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
 * Leading-zero octets (`012.0.0.1`) are rejected for the same reason: URL parsers
 * and resolvers do not agree on the radix, so the form is not one we can vouch for.
 */

export type ParsedAddress =
  | { readonly family: 4; readonly octets: readonly [number, number, number, number] }
  | { readonly family: 6; readonly groups: readonly number[] };

/**
 * Strips bracket, zone id and one trailing dot; does not touch case. Applied
 * exactly once per public call — it is deliberately not idempotent (`8.8.8.8..`
 * survives one pass unparseable and a second pass as a public address), so every
 * entry point normalises and then works on `parseNormalized`, never on
 * `parseIpAddress` again.
 */
function normalize(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const zone = withoutBrackets.indexOf('%');
  const withoutZone = zone === -1 ? withoutBrackets : withoutBrackets.slice(0, zone);
  return withoutZone.endsWith('.') ? withoutZone.slice(0, -1) : withoutZone;
}

/** A dotted quad as four octets, or null when it is not a well-formed one. */
function parseIPv4Literal(text: string): readonly [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    // Number("012") is 12, but URL parsers still read a leading zero as octal
    // (`012.0.0.1` → 10.0.0.1) while some resolvers strip it as decimal. Reject
    // the ambiguous form rather than pick a radix the next hop might not share.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets as [number, number, number, number];
}

/**
 * The 16-bit groups of one side of an IPv6 address. A dotted quad is only legal
 * as the last run of the whole address (the uncompressed form, or the tail of a
 * `::` split) — `1.2.3.4::` is not an address.
 */
function parseHextets(text: string, allowIPv4: boolean): number[] | null {
  if (text === '') return [];

  const parts = text.split(':');
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    // A dotted quad stands for the final two groups, so it is only legal last.
    if (part.includes('.')) {
      if (!allowIPv4 || index !== parts.length - 1) return null;
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

  const head = parseHextets(halves[0], halves.length === 1);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parseHextets(halves[1], true);
  if (tail === null) return null;

  const elided = 8 - head.length - tail.length;
  if (elided < 1) return null;
  return [...head, ...Array<number>(elided).fill(0), ...tail];
}

/** Reads already-normalised text; every public entry point normalises first. */
function parseNormalized(normalized: string): ParsedAddress | null {
  const octets = parseIPv4Literal(normalized);
  if (octets !== null) return { family: 4, octets };

  const groups = parseIPv6(normalized);
  if (groups !== null) return { family: 6, groups };

  return null;
}

/** Parses a loopback, private-range or public address in any of the forms above. */
export function parseIpAddress(value: string): ParsedAddress | null {
  return parseNormalized(normalize(value));
}

/**
 * A host rendered so it can be interpolated into a URL: an IPv6 address gets the
 * brackets `http://::1:3001` would otherwise read as part of the port. Bracketing
 * is the parser's job rather than a call site's, because only the parser knows
 * that `::1%lo0` is IPv6 *and* that the zone id has to come off first — `new URL`
 * rejects a bracketed zone id.
 */
export function formatHostForUrl(value: string): string {
  const normalized = normalize(value);
  return parseNormalized(normalized)?.family === 6 ? `[${normalized}]` : normalized;
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

function isMulticastIPv6(groups: readonly number[]): boolean {
  return (groups[0] & 0xff00) === 0xff00;
}

function toNumber(octets: readonly [number, number, number, number]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipv4Range(network: readonly [number, number, number, number], prefixBits: number) {
  const mask = (~0 << (32 - prefixBits)) >>> 0;
  return [toNumber(network) & mask, mask] as const;
}

/** Ranges that must never be reached by outbound requests or counted as public. */
const PRIVATE_OR_LOCAL_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  ipv4Range([127, 0, 0, 0], 8), // loopback
  ipv4Range([10, 0, 0, 0], 8), // RFC1918
  ipv4Range([172, 16, 0, 0], 12), // RFC1918
  ipv4Range([192, 168, 0, 0], 16), // RFC1918
  ipv4Range([169, 254, 0, 0], 16), // link-local
  ipv4Range([100, 64, 0, 0], 10), // CGNAT (RFC 6598)
  ipv4Range([0, 0, 0, 0], 8), // "this network" / unspecified
  ipv4Range([192, 0, 0, 0], 24), // IETF protocol assignments (RFC 6890)
  ipv4Range([224, 0, 0, 0], 4), // multicast
  ipv4Range([240, 0, 0, 0], 4), // reserved, covers 255.255.255.255 broadcast
];

function isPrivateOrLocalIPv4(octets: readonly [number, number, number, number]): boolean {
  const num = toNumber(octets);
  return PRIVATE_OR_LOCAL_IPV4_RANGES.some(([network, mask]) => (num & mask) === network);
}

/**
 * True for `localhost` and any address in the 127.0.0.0/8 or `::1` loopback ranges.
 *
 * Fails **open** on an address it cannot parse (`false` — "not proven loopback"),
 * the opposite of {@link isPrivateOrLocal}. The two directions are deliberate and
 * not interchangeable: this one gates access *in* to the hub, where an unreadable
 * address must not pass for local, while `isPrivateOrLocal` gates requests *out*,
 * where an unreadable address must not pass for public. A caller that wants
 * "is this host on my machine or my network?" wants `isPrivateOrLocal` guarded by
 * a successful {@link parseIpAddress}, not either predicate alone.
 */
export function isLoopback(value: string): boolean {
  const normalized = normalize(value);
  if (normalized === 'localhost') return true;

  const parsed = parseNormalized(normalized);
  if (parsed === null) return false;
  if (parsed.family === 4) return parsed.octets[0] === 127;

  if (isIPv6Loopback(parsed.groups)) return true;
  const embedded = embeddedIPv4(parsed.groups);
  return embedded !== null && embedded[0] === 127;
}

/**
 * True for `localhost`, loopback, RFC1918, link-local, CGNAT, IETF protocol
 * assignment, multicast, reserved and broadcast addresses, and for any address
 * this module cannot parse. An address it cannot read is one it cannot vouch for,
 * and every form a URL parser or a resolver actually hands us parses — so refusing
 * the rest costs nothing real and keeps an unreadable address out of the public
 * path. This fail-**closed** direction is the opposite of {@link isLoopback}'s;
 * see the note there before picking between them.
 */
export function isPrivateOrLocal(value: string): boolean {
  const normalized = normalize(value);
  if (normalized === 'localhost') return true;

  const parsed = parseNormalized(normalized);
  if (parsed === null) return true;
  if (parsed.family === 4) return isPrivateOrLocalIPv4(parsed.octets);

  const embedded = embeddedIPv4(parsed.groups);
  if (embedded !== null) return isPrivateOrLocalIPv4(embedded);
  return (
    isUniqueLocalIPv6(parsed.groups) ||
    isLinkLocalIPv6(parsed.groups) ||
    isMulticastIPv6(parsed.groups)
  );
}
