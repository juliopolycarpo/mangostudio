/**
 * Bounds for text a vendor process produced.
 *
 * Everything an external agent emits is attacker-adjacent in the ordinary
 * sense: it is text MangoStudio did not write, rendered in MangoStudio's UI and
 * persisted in MangoStudio's database. "Cap the length" is not a specification,
 * so the caps live here as numbers, applied once at the runtime boundary —
 * before an event is persisted or rendered, not at each render site.
 *
 * Three separate things are done, in this order:
 *
 * 1. Control characters are stripped. C0 and C1 both, keeping only `\n` and
 *    `\t`, because a lone `\r` or an escape sequence in a "tool name" is a
 *    terminal-rendering problem the moment anyone tails a log.
 * 2. Bidirectional overrides are stripped. They let a string render in an order
 *    its code points do not have, which is exactly how a benign-looking command
 *    label hides what it will run.
 * 3. Lone surrogates are stripped. Not cutting a pair in half is only half the
 *    guarantee: vendor JSON can already carry an unpaired `\ud800`, and it
 *    survives every step above to become U+FFFD on the way out to UTF-8 —
 *    silently rewriting an opaque session or request id we later echo back.
 * 4. The remainder is cut to a **code-point** count. Never UTF-16 units: a cut
 *    between the halves of a surrogate pair produces a lone surrogate, which is
 *    not valid UTF-8 and fails to encode on its way out.
 *
 * Browser-safe by construction — no Node builtins.
 */

/** Every bounded field, and how many code points it may keep. */
export const EXTERNAL_TEXT_LIMITS = {
  /** The vendor's own tool name, rendered as the activity pill's label. */
  activityName: 128,
  /** Activity title and approval title alike. */
  title: 256,
  /** Activity detail and approval detail alike. */
  detail: 4_096,
  /** Label text the vendor supplied for one approval option. */
  approvalOptionLabel: 128,
  /** Title of a native vendor session, when one is adopted. */
  sessionTitle: 256,
  errorMessage: 2_048,
  /**
   * Opaque vendor identifiers — session, call, request and option ids, and
   * vendor error codes. They cross the wire and are echoed back to the vendor,
   * so they are bounded on the same terms as rendered vendor text.
   */
  vendorId: 128,
  /** Minimal account display label. Never the raw email. */
  accountLabel: 128,
  /** A slash command's invocable name, without its leading `/`. */
  commandName: 128,
  /**
   * One line of help for a slash command, as the vendor wrote it.
   *
   * Wider than `title` because this is prose the vendor chose for a picker, not
   * a label it derived: Cursor ships command descriptions that run past 250
   * code points, and cutting them at a title's length would truncate the half
   * that says what the command does.
   */
  commandDescription: 512,
} as const;

export type ExternalTextLimit = keyof typeof EXTERNAL_TEXT_LIMITS;

/**
 * One turn's worth of persisted external events, in bytes.
 *
 * A single in-bounds event says nothing about ten thousand of them, and a
 * vendor emitting deltas in a loop is the ordinary case rather than the exotic
 * one. The turn controller stops persisting past this and records that it did.
 */
export const EXTERNAL_TURN_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One turn's worth of persisted external events, counted.
 *
 * The byte budget alone does not bound the work: a vendor emitting empty
 * activity updates stays far under it while turning every persisted write into
 * a walk over an ever-growing part list. Both caps terminate the turn with the
 * same recorded reason, so neither can be exceeded quietly.
 */
export const EXTERNAL_TURN_MAX_EVENTS = 10_000;

/**
 * How many choices one approval may carry.
 *
 * An adapter that passes a vendor's option set through has to refuse a larger
 * one at its own boundary rather than emit it: the neutral event would fail
 * validation in the supervisor, which ends the whole turn — a far worse answer
 * to an unrenderable permission request than refusing that one request.
 */
export const EXTERNAL_APPROVAL_MAX_OPTIONS = 16;

export interface BoundedVendorText {
  readonly text: string;
  /** True when stripping or truncation changed the input. */
  readonly truncated: boolean;
}

/**
 * C0 and C1 controls except tab and newline, every bidirectional formatting
 * character — ALM, LRM/RLM, the LRE-to-RLO overrides with PDF, and the
 * LRI-to-PDI isolates — and lone surrogates.
 *
 * A surrogate code point only ever reaches here unpaired: iterating a string by
 * code point yields a well-formed pair as its combined value at or above
 * U+10000, so anything left in D800-DFFF is half a character that no UTF-8
 * encoder can represent.
 *
 * Expressed as code-point tests rather than a character class: a regex made of
 * escaped control characters is unreviewable, and this is exactly the code
 * where a wrong range would go unnoticed.
 */
function isStrippable(codePoint: number): boolean {
  const TAB = 0x09;
  const NEWLINE = 0x0a;
  if (codePoint === TAB || codePoint === NEWLINE) return false;

  if (codePoint <= 0x1f) return true; // C0
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true; // DEL and C1
  if (codePoint === 0x061c) return true; // ARABIC LETTER MARK
  if (codePoint === 0x200e || codePoint === 0x200f) return true; // LRM, RLM
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true; // LRE-to-RLO, PDF
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true; // lone surrogate
  return codePoint >= 0x2066 && codePoint <= 0x2069; // LRI-to-PDI
}

/**
 * Removes terminal- and wire-unsafe code points without imposing a field cap.
 *
 * Streaming text is bounded by the per-turn byte budget rather than one of
 * the small label limits below, but it still must not carry control sequences,
 * bidi overrides or lone surrogates across the runtime boundary.
 */
export function sanitizeVendorText(raw: string): BoundedVendorText {
  const kept: string[] = [];
  let removed = false;

  for (const character of raw) {
    if (isStrippable(character.codePointAt(0) ?? 0)) {
      removed = true;
      continue;
    }
    kept.push(character);
  }

  return { text: kept.join(''), truncated: removed };
}

/**
 * Applies one field's bound to vendor-supplied text.
 *
 * Returns the text to persist and whether anything was removed, so a caller can
 * mark the event as truncated rather than silently shortening what a user reads.
 */
export function boundVendorText(raw: string, limit: ExternalTextLimit): BoundedVendorText {
  const max = EXTERNAL_TEXT_LIMITS[limit];
  const kept: string[] = [];
  let removed = false;

  // `for...of` over a string yields whole code points, so a surrogate pair is
  // one iteration and can never be cut in half by the limit below.
  for (const character of raw) {
    if (isStrippable(character.codePointAt(0) ?? 0)) {
      removed = true;
      continue;
    }
    if (kept.length === max) {
      removed = true;
      break;
    }
    kept.push(character);
  }

  return { text: kept.join(''), truncated: removed };
}

/**
 * The `maxLength` to put on a schema field bounded by `limit`.
 *
 * TypeBox evaluates `maxLength` against `String.prototype.length` - UTF-16
 * units - while the bound above counts code points, and one code point is at
 * most two units. Doubling keeps the schema from ever rejecting a correctly
 * bounded string while still refusing an unbounded one.
 */
export function schemaMaxLengthFor(limit: ExternalTextLimit): number {
  return EXTERNAL_TEXT_LIMITS[limit] * 2;
}
