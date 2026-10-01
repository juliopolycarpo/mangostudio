/**
 * `Accept-Encoding` negotiation (RFC 9110 §12.5.3) over a fixed set of ready,
 * precompressed representations. Nothing here compresses: the answer names an
 * existing representation, or says none is acceptable.
 */

import type { EmbeddedContentCoding } from './embedded-frontend';

/** What the client's header resolves to for one resource. */
export type EncodingChoice = EmbeddedContentCoding | 'identity';

/** Server preference among compressed codings that tie on weight: smallest first. */
const PREFERENCE: readonly EmbeddedContentCoding[] = ['br', 'gzip'];

const TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
/** RFC 9110 `weight`: 0 to 1 with at most three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parses a header into coding → weight. Codings are lowercased and `x-gzip` is
 * folded into `gzip` (RFC 9110 §8.4.1.3).
 *
 * A member that is malformed — a bad token or an unparsable weight — is ignored
 * rather than failing the request: the client still gets a usable response, and
 * a header that is garbled end to end resolves to the same answer as none. A
 * coding listed twice keeps its first weight; the RFC does not define a winner.
 */
function parseAcceptEncoding(header: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const member of header.split(',')) {
    const [rawToken, ...params] = member.split(';').map((part) => part.trim());
    const token = rawToken?.toLowerCase() ?? '';
    if (!TOKEN.test(token)) continue;
    const weight = parseWeight(params);
    if (weight === null) continue;
    const coding = token === 'x-gzip' ? 'gzip' : token;
    if (!weights.has(coding)) weights.set(coding, weight);
  }
  return weights;
}

/** The weight a member's parameters carry: 1 when there is none, null when it is malformed. */
function parseWeight(params: readonly string[]): number | null {
  const param = params.find((candidate) => /^q\s*=/i.test(candidate));
  if (param === undefined) return 1;
  const value = param.slice(param.indexOf('=') + 1).trim();
  return QVALUE.test(value) ? Number(value) : null;
}

/**
 * Picks the representation to send.
 *
 * - No header, or an empty one: identity. Absent means any coding is acceptable
 *   and the server may choose, and identity is the safe choice.
 * - A compressed coding is acceptable at its own weight, else at `*`'s, else not
 *   at all. Highest weight wins; a tie goes to the smaller (`br` over `gzip`).
 * - Identity is the fallback. Left implicit it never outranks a compressed coding
 *   the client asked for, so `gzip` alone gets gzip. Listed (or implied by `*`),
 *   it competes on weight and wins only when strictly higher.
 * - A client that refuses every representation on offer (`identity;q=0`,
 *   `*;q=0`) still gets identity. RFC 9110 §12.5.3 lets a server ignore the
 *   header, and a request that was answered with identity before copies existed
 *   must not start failing because copies do.
 *
 * @example
 * negotiateEncoding('gzip, br;q=0.8', ['br', 'gzip']); // 'gzip'
 */
export function negotiateEncoding(
  header: string | null,
  available: readonly EmbeddedContentCoding[]
): EncodingChoice {
  if (header === null) return 'identity';
  const weights = parseAcceptEncoding(header);
  const wildcard = weights.get('*');

  let best: EmbeddedContentCoding | null = null;
  let bestWeight = 0;
  for (const coding of PREFERENCE) {
    if (!available.includes(coding)) continue;
    const weight = weights.get(coding) ?? wildcard ?? 0;
    if (weight > bestWeight) {
      best = coding;
      bestWeight = weight;
    }
  }

  const explicitIdentity = weights.get('identity') ?? wildcard;
  if (best !== null && (explicitIdentity === undefined || bestWeight >= explicitIdentity)) {
    return best;
  }
  return 'identity';
}

/**
 * Add `Accept-Encoding` to the `Vary` Elysia has already accumulated for this
 * response, keeping what is there (CORS writes `Vary: Origin`).
 *
 * Elysia merges its accumulated headers into a returned `Response` only for
 * names the response does not carry itself, so a `Response` built with its own
 * `Vary` would silently drop `Origin` — and a shared cache would then hand one
 * origin's CORS answer to another. The existing key is updated in place,
 * whatever its casing, so the header is emitted once.
 *
 * @example
 * varyOnAcceptEncoding(set.headers); // 'Origin' -> 'Origin, Accept-Encoding'
 */
export function varyOnAcceptEncoding(headers: object): void {
  const field = headers as Record<string, unknown>;
  const key = Object.keys(field).find((name) => name.toLowerCase() === 'vary');
  const existing = key ? field[key] : undefined;
  const directives = (Array.isArray(existing) ? existing : [existing])
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  // `Vary: *` already covers every request header.
  if (directives.some((value) => value === '*' || value.toLowerCase() === 'accept-encoding')) {
    return;
  }
  field[key ?? 'Vary'] = [...directives, 'Accept-Encoding'].join(', ');
}
