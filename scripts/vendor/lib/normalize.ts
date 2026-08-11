/**
 * Turns a live vendor reply into something that can be committed and diffed.
 *
 * Cursor and Claude ship no schema generator, so their "contract" is whatever
 * their binaries answered. Committing those answers verbatim does not work, for
 * two independent reasons:
 *
 * - **They are not reproducible.** Session ids, timestamps, model catalogs and
 *   free text change between two runs of the same binary, so a verbatim capture
 *   would report drift on every re-capture and the check would mean nothing.
 * - **They are not ours to publish.** `session/list` returns the operator's own
 *   session titles and working directories; `claude auth status` returns an
 *   email address, an organization id and an organization name. A redaction
 *   list would have to be updated *before* the vendor added a field, which is
 *   backwards — the moment a capture is most likely to carry something new is
 *   exactly the moment the vendor changed something.
 *
 * So the capture keeps the **shape** and discards the values: object keys,
 * nesting, and the type of every leaf. That is what the adapters actually
 * depend on, and it is the thing whose change is worth a maintainer's
 * attention. `preserveAt` opts specific keys back into carrying their value,
 * for the handful of places where the value *is* the contract — a negotiated
 * protocol version, a permission mode's id.
 *
 * Arrays collapse to the set of distinct element shapes rather than a list of
 * elements. A `session/list` page with nine entries and one with two describe
 * the same contract, and a capture that reported "9 → 2" as drift would train
 * whoever reads it to ignore the output.
 */

/** The stand-ins a normalized leaf is reduced to. */
const TYPE_TOKENS = {
  string: '<string>',
  number: '<number>',
  boolean: '<boolean>',
  null: '<null>',
} as const;

export interface NormalizeOptions {
  /**
   * Keys whose value survives normalization.
   *
   * Matched on the key name alone, at any depth, and only for string, number
   * and boolean leaves. Nothing here may name a key that can carry personal
   * data: the point is enum-shaped identifiers — `protocolVersion`, a mode's
   * `id` — where a value disappearing is the drift.
   */
  readonly preserveAt?: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenFor(value: unknown): string {
  if (value === null) return TYPE_TOKENS.null;
  if (typeof value === 'string') return TYPE_TOKENS.string;
  if (typeof value === 'number') return TYPE_TOKENS.number;
  if (typeof value === 'boolean') return TYPE_TOKENS.boolean;
  // Functions, symbols and undefined cannot survive a JSON round-trip, so
  // reaching here means the caller passed something that was never a reply.
  return TYPE_TOKENS.string;
}

/**
 * The distinct shapes in an array, ordered by their serialized form.
 *
 * Deduplicating is what makes a page of sessions and a page of one session
 * compare equal; sorting is what makes two captures of the same page compare
 * equal when the vendor's ordering is not stable.
 */
function normalizeArray(values: readonly unknown[], options: NormalizeOptions): unknown[] {
  const seen = new Map<string, unknown>();
  for (const value of values) {
    const shape = normalizeCapture(value, options);
    seen.set(JSON.stringify(shape), shape);
  }
  return [...seen.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, shape]) => shape);
}

/** Reduces a parsed vendor reply to its committed, diffable shape. */
export function normalizeCapture(value: unknown, options: NormalizeOptions = {}): unknown {
  if (Array.isArray(value)) return normalizeArray(value, options);
  if (!isPlainObject(value)) return tokenFor(value);

  const preserve = new Set(options.preserveAt ?? []);
  const normalized: Record<string, unknown> = {};
  // Sorted, so a vendor that reorders its own keys is not drift.
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (
      preserve.has(key) &&
      (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')
    ) {
      normalized[key] = child;
      continue;
    }
    normalized[key] = normalizeCapture(child, options);
  }
  return normalized;
}

/** The committed form: two-space JSON with a trailing newline, byte-stable. */
export function serializeCapture(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
