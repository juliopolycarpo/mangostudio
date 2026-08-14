/**
 * Content negotiation between the two error representations.
 *
 * Framework-agnostic on purpose: the API picks a representation here, and any
 * client can use the same rule to predict which one it will get. Nothing in
 * this file may import a runtime — it runs in the browser bundle too.
 */

/** The RFC 9457 media type. */
export const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/** The default media type every existing MangoStudio client already expects. */
export const LEGACY_ERROR_MEDIA_TYPE = 'application/json';

/**
 * `Accept` value a client sends to opt into problem details while still
 * declaring the legacy shape acceptable. Exported so the frontend and the
 * documentation cannot drift from what the parser actually rewards.
 */
export const PROBLEM_JSON_ACCEPT = `${PROBLEM_JSON_MEDIA_TYPE}, ${LEGACY_ERROR_MEDIA_TYPE};q=0.9`;

interface MediaRange {
  type: string;
  subtype: string;
  quality: number;
}

/**
 * Split on a separator that is structural, ignoring the ones inside quoted
 * parameter values.
 *
 * Both separators in an `Accept` header need this. A comma inside a quote is
 * part of one range (`;title="a,b"`), and so is a semicolon
 * (`;profile="a;q=0"`) — reading the second one naively invents a `q` parameter
 * the client never sent.
 *
 * Hand-rolled rather than a regex: an `Accept` header is attacker-controlled on
 * every request, and a backtracking pattern over one is a denial-of-service
 * waiting to happen.
 */
function splitUnquoted(value: string, separator: ',' | ';'): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts;
}

/**
 * Read the `q` parameter of one media range.
 *
 * An absent or unreadable `q` means 1: quality is optional, and a malformed
 * value should not silently delete a range the client did ask for. Values
 * outside `[0, 1]` are clamped rather than rejected for the same reason.
 */
function parseQuality(parameters: string[]): number {
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator === -1) continue;
    if (parameter.slice(0, separator).trim().toLowerCase() !== 'q') continue;

    const quality = Number.parseFloat(parameter.slice(separator + 1).trim());
    if (Number.isNaN(quality)) return 1;
    return Math.min(1, Math.max(0, quality));
  }
  return 1;
}

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];

  for (const raw of splitUnquoted(header, ',')) {
    const [mediaRange, ...parameters] = splitUnquoted(raw, ';');
    const trimmed = mediaRange?.trim().toLowerCase() ?? '';
    if (!trimmed) continue;

    const slash = trimmed.indexOf('/');
    if (slash === -1) continue;

    const type = trimmed.slice(0, slash);
    const subtype = trimmed.slice(slash + 1);
    if (!type || !subtype) continue;

    ranges.push({ type, subtype, quality: parseQuality(parameters) });
  }

  return ranges;
}

/** How specifically a range names a media type; higher wins outright. */
const PRECEDENCE = {
  none: -1,
  wildcard: 0,
  subtype: 1,
  exact: 2,
} as const;

type Precedence = (typeof PRECEDENCE)[keyof typeof PRECEDENCE];

function precedenceFor(range: MediaRange, type: string, subtype: string): Precedence {
  if (range.type === type && range.subtype === subtype) return PRECEDENCE.exact;
  if (range.type === type && range.subtype === '*') return PRECEDENCE.subtype;
  if (range.type === '*' && range.subtype === '*') return PRECEDENCE.wildcard;
  return PRECEDENCE.none;
}

/**
 * Quality the header assigns to a media type, or `undefined` when no range
 * covers it.
 *
 * Specificity decides before quality does, per RFC 9110 §12.5.1: the most
 * precise range that matches is the one that applies, and `q` only breaks ties
 * between ranges of equal precision. Taking the highest `q` across all matches
 * instead would let a `q=1` wildcard overrule an explicit
 * `application/json;q=0.1` and hand the legacy body to a client that named
 * problem details at a higher `q`.
 *
 * `exactOnly` is what keeps this opt-in. A client sending only wildcards — bare
 * `*` over `*`, or a browser's `text/html` list ending in one — accepts problem
 * details in the strict HTTP sense, but it has not asked for them. Answering
 * those with RFC 9457 would break every existing MangoStudio client on the day
 * this shipped. So only an exact type/subtype match counts as opting in, while
 * wildcards still count for the legacy media type, which is what they have
 * always been served.
 */
function qualityFor(
  ranges: readonly MediaRange[],
  mediaType: string,
  exactOnly: boolean
): number | undefined {
  const slash = mediaType.indexOf('/');
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);

  let bestPrecedence: Precedence = PRECEDENCE.none;
  let best: number | undefined;

  for (const range of ranges) {
    const precedence = precedenceFor(range, type, subtype);
    if (precedence === PRECEDENCE.none) continue;
    if (exactOnly && precedence !== PRECEDENCE.exact) continue;
    if (precedence < bestPrecedence) continue;

    if (precedence > bestPrecedence) {
      bestPrecedence = precedence;
      best = range.quality;
      continue;
    }
    if (best === undefined || range.quality > best) best = range.quality;
  }

  return best;
}

/**
 * True when the caller explicitly asked for RFC 9457 problem details.
 *
 * The rule, in order:
 *
 * 1. no `Accept`, or one naming problem details only through a wildcard —
 *    legacy, because the client never asked;
 * 2. `application/problem+json;q=0` — legacy, because the client refused it;
 * 3. both named — whichever carries the higher quality, with problem details
 *    winning an outright tie, since naming it at all is the opt-in signal;
 * 4. anything unparseable — legacy, because the safe answer to a header we did
 *    not understand is the representation every client already handles.
 */
export function prefersProblemDetails(accept: string | null | undefined): boolean {
  if (!accept) return false;

  const ranges = parseAccept(accept);
  const problem = qualityFor(ranges, PROBLEM_JSON_MEDIA_TYPE, true);
  if (problem === undefined || problem === 0) return false;

  const legacy = qualityFor(ranges, LEGACY_ERROR_MEDIA_TYPE, false) ?? 0;
  return problem >= legacy;
}
