/**
 * `Range` for a body the server holds in memory.
 *
 * Bun answers `Range` itself when a `Response` wraps a `Bun.file`, but ignores it
 * for a `Uint8Array` body. An embedded asset whose identity bytes are inflated at
 * request time is the second kind, so the same verdicts Bun gives a stored file
 * are spelled out here, and a client resuming an identity download keeps
 * getting 206.
 *
 * Only a single `bytes=` range is honoured. Everything else, from a multi-range
 * list to a malformed header, is "no range": the whole body, status 200, which
 * RFC 9110 allows for any range a server does not support.
 */

/** What to do with a request's `Range` header for a body of a known length. */
export type ByteRangeVerdict =
  { kind: 'whole' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

/** `bytes=<first>-<last>`, either side optional but not both; whitespace and case are forgiven. */
const SINGLE_BYTE_RANGE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/**
 * Resolves a `Range` header against a body of `size` bytes. `end` is inclusive.
 *
 * - `first-last`: `last` is clamped to the end; `last < first` is not a range.
 * - `first-`: from `first` to the end.
 * - `-count`: the final `count` bytes, clamped to the whole body; `-0` is unsatisfiable.
 * - `first` at or past the end, or an empty body: unsatisfiable (416).
 *
 * // Usage: resolveByteRange('bytes=0-9', 100) // { kind: 'partial', start: 0, end: 9 }
 */
export function resolveByteRange(header: string | null, size: number): ByteRangeVerdict {
  if (header === null) return { kind: 'whole' };
  const match = SINGLE_BYTE_RANGE.exec(header);
  if (!match) return { kind: 'whole' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'whole' };

  if (first === '') {
    const count = Number(last);
    if (count === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - count), end: size - 1 };
  }

  const start = Number(first);
  if (last !== '' && Number(last) < start) return { kind: 'whole' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}
