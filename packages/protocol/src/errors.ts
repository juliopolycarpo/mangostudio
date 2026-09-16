/**
 * The error vocabulary of the SDK: the reserved `error.code` values of
 * spec/mango-protocol-1.md §6.3, the refusal kinds a decoder reports, and the
 * two error classes the SDK throws.
 */

/** Codes this specification reserves; applications define any other code. */
export const RESERVED_ERROR_CODES = {
  UNAVAILABLE: 'UNAVAILABLE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  METHOD_UNSUPPORTED: 'METHOD_UNSUPPORTED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  DENIED: 'DENIED',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  INTERNAL: 'INTERNAL',
} as const;

/** One of the ten codes §6.3 reserves. */
export type ReservedErrorCode = (typeof RESERVED_ERROR_CODES)[keyof typeof RESERVED_ERROR_CODES];

/**
 * True when `code` is one of the reserved codes. Unknown codes are valid on the
 * wire and MUST be preserved as received, so this narrows rather than validates.
 *
 * @example
 * isReservedErrorCode('DENIED'); // true
 */
export function isReservedErrorCode(code: string): code is ReservedErrorCode {
  return Object.hasOwn(RESERVED_ERROR_CODES, code);
}

/**
 * Why a decoder refused its input. `invalid-json`, `schema`, `too-large` and
 * `empty` come from the NDJSON line codec; the `chunk-*` kinds come from the
 * WebSocket chunk codec.
 */
export type CodecErrorKind =
  | 'invalid-json'
  | 'schema'
  | 'too-large'
  | 'empty'
  | 'chunk-version'
  | 'chunk-header'
  | 'chunk-count'
  | 'chunk-index'
  | 'chunk-dribble';

/** Options a refusal may carry beyond its kind and message. */
export interface CodecErrorOptions {
  /** The `type` member of the refused frame, when the input parsed that far. */
  readonly frameType?: string;
}

/**
 * A decoder refusal. Every message names the received value and the shape the
 * spec expects, so a transport can log one line and close with the right code.
 *
 * @example
 * throw new CodecError('too-large', 'line is 5000 bytes; expected at most 4096');
 */
export class CodecError extends Error {
  readonly kind: CodecErrorKind;
  readonly frameType?: string;

  constructor(kind: CodecErrorKind, message: string, options?: CodecErrorOptions) {
    super(message);
    this.name = 'CodecError';
    this.kind = kind;
    if (options?.frameType !== undefined) this.frameType = options.frameType;
  }
}

/**
 * What a requester receives when its request is answered with an `err` frame.
 * `code` is preserved exactly as it arrived, including codes this SDK does not
 * know.
 *
 * @example
 * throw new RemoteError('DENIED', 'fsRead was not granted', { capability: 'fsRead' });
 */
export class RemoteError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
