/**
 * Wire version constants and the negotiation rule of
 * spec/mango-protocol-1.md §5.2.
 */

import { CLOSE_CODES } from './close';

/** The wire major this SDK speaks. */
export const PROTOCOL_MAJOR = 1 as const;

/** The highest minor of that major this SDK implements. */
export const PROTOCOL_MINOR = 2 as const;

/**
 * The wire minor from which a responder writes every frame a handler asked
 * for ahead of that request's answer (spec §6.2). A feature minor, not the
 * current one: it stays `2` when later minors ship. At or above it a
 * requester may treat the answer as the end of what the call emitted.
 *
 * @example
 * const ordered = session.remote.effectiveMinor >= ORDERED_ANSWER_MINOR;
 */
export const ORDERED_ANSWER_MINOR = 2 as const;

/** The `protocol` member of a `hello` frame. */
export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** The version this SDK announces in `hello`. */
export const PROTOCOL_VERSION: ProtocolVersion = { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR };

/**
 * The outcome of §5.2: either both peers agree on an effective minor, or the
 * majors differ and the session closes with `4426`.
 */
export type Negotiation =
  | { readonly ok: true; readonly effectiveMinor: number }
  | { readonly ok: false; readonly closeCode: 4426 };

/**
 * Negotiates the effective minor from the two `hello.protocol` values: the
 * lower minor when the majors match, otherwise a `4426` refusal. Both peers
 * derive the same answer from the same pair.
 *
 * @example
 * negotiate({ major: 1, minor: 5 }, { major: 1, minor: 2 }); // { ok: true, effectiveMinor: 2 }
 */
export function negotiate(local: ProtocolVersion, remote: ProtocolVersion): Negotiation {
  if (local.major !== remote.major) return { ok: false, closeCode: CLOSE_CODES.PROTOCOL_MISMATCH };
  return { ok: true, effectiveMinor: Math.min(local.minor, remote.minor) };
}
