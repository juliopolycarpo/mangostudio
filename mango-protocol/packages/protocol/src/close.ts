/**
 * The close-code table of spec/mango-protocol-1.md §10: the eight named reason
 * codes, the fatal set a peer must never retry, and the code a transport sends
 * after a decoder refusal.
 */

import type { CodecError } from './errors';

/** The reason codes §10 names. Any other integer in 4000–4999 is also valid. */
export const CLOSE_CODES = {
  RELEASED: 4000,
  PROTOCOL_ERROR: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  SUPERSEDED: 4409,
  PROTOCOL_MISMATCH: 4426,
  RATE_LIMITED: 4429,
  INTERNAL: 4500,
} as const;

/** One of the eight named reason codes. */
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

const CLOSE_CODE_MIN = 4000;
const CLOSE_CODE_MAX = 4999;

/** Redialing after one of these cannot change the outcome (§10, the fatal set). */
const FATAL_CLOSE_CODES: readonly number[] = [
  CLOSE_CODES.UNAUTHORIZED,
  CLOSE_CODES.FORBIDDEN,
  CLOSE_CODES.SUPERSEDED,
  CLOSE_CODES.PROTOCOL_MISMATCH,
];

/**
 * True for `4401`, `4403`, `4409` and `4426`: a peer MUST NOT reconnect
 * automatically after one of them.
 *
 * @example
 * isFatalCloseCode(4426); // true
 */
export function isFatalCloseCode(code: number): boolean {
  return FATAL_CLOSE_CODES.includes(code);
}

/**
 * The name §10 gives a code, or `undefined` for an unlisted code in range.
 *
 * @example
 * closeCodeName(4409); // 'SUPERSEDED'
 */
export function closeCodeName(code: number): string | undefined {
  for (const [name, value] of Object.entries(CLOSE_CODES)) {
    if (value === code) return name;
  }
  return undefined;
}

/**
 * True when `code` is an integer a `close` frame may carry: `4000`–`4999`,
 * named or not.
 *
 * @example
 * isCloseCode(4777); // true, unlisted but in range
 */
export function isCloseCode(code: number): boolean {
  return Number.isInteger(code) && code >= CLOSE_CODE_MIN && code <= CLOSE_CODE_MAX;
}

/**
 * The close code a transport sends after a decoder refusal: `4426` when the
 * refused frame was a `hello` that failed the schema (§5.2, the peer speaks
 * another wire version), `4400` for every other refusal (§10).
 *
 * @example
 * closeCodeForCodecError(new CodecError('invalid-json', 'not JSON')); // 4400
 */
export function closeCodeForCodecError(error: CodecError): 4400 | 4426 {
  if (error.kind === 'schema' && error.frameType === 'hello') return CLOSE_CODES.PROTOCOL_MISMATCH;
  return CLOSE_CODES.PROTOCOL_ERROR;
}
