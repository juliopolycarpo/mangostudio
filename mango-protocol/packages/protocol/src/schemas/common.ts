/**
 * The scalar shapes every frame and the catalog document share, mirroring the
 * `$defs` of spec/schema/1/protocol.json member for member.
 *
 * Objects on this wire are open: a decoder ignores members it does not know, so
 * no schema here sets `additionalProperties`.
 */

import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

/** Method and topic grammar of §6.1, exactly as `protocol.json` spells it. */
export const METHOD_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** `error.code` grammar of §6.2. */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** `peer.role` grammar of §5.1. */
const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Longest `id` and `evt.streamId` the wire accepts (§11). */
export const ID_MAX_LENGTH = 256;

/** Longest `method` and `topic` the wire accepts (§11). */
export const METHOD_MAX_LENGTH = 128;

/** Shortest method or topic the grammar can produce, `a.b`. */
const METHOD_MIN_LENGTH = 3;

/** Longest `error.code` the wire accepts (§11). */
export const ERROR_CODE_MAX_LENGTH = 64;

/** Longest `close.reason` the wire accepts (§11). */
export const CLOSE_REASON_MAX_LENGTH = 1024;

/** Longest `peer.name` and `peer.version` the wire accepts (§11). */
export const PEER_FIELD_MAX_LENGTH = 128;

/** Longest `peer.role` the wire accepts. */
export const ROLE_MAX_LENGTH = 64;

/** Lowest and highest `close.code` (§10). */
const CLOSE_CODE_MINIMUM = 4000;
const CLOSE_CODE_MAXIMUM = 4999;

/** Request identifier, also used by `evt.streamId`. */
export const IdSchema = Type.String({
  minLength: 1,
  maxLength: ID_MAX_LENGTH,
  description: "Request identifier, unique among the sender's in-flight requests.",
});

/** Method name: two or more dot-separated lowercase segments. */
export const MethodSchema = Type.String({
  minLength: METHOD_MIN_LENGTH,
  maxLength: METHOD_MAX_LENGTH,
  pattern: METHOD_PATTERN.source,
  description:
    'Dot-separated lowercase segments; a segment starts with a letter and never ends with a dash. The rpc. segment is reserved.',
});

/** Event topic: the method grammar, applied to events. */
export const TopicSchema = Type.String({
  minLength: METHOD_MIN_LENGTH,
  maxLength: METHOD_MAX_LENGTH,
  pattern: METHOD_PATTERN.source,
  description: 'Event topic, same grammar as a method name; the rpc. segment is reserved.',
});

/** `error.code`: SCREAMING_SNAKE_CASE, 1 to 64 characters. */
export const ErrorCodeSchema = Type.String({
  minLength: 1,
  maxLength: ERROR_CODE_MAX_LENGTH,
  pattern: ERROR_CODE_PATTERN.source,
});

/** `close.code`: an integer in 4000-4999. */
export const CloseCodeSchema = Type.Integer({
  minimum: CLOSE_CODE_MINIMUM,
  maximum: CLOSE_CODE_MAXIMUM,
});

/** `peer.role`: a lowercase label the application interprets. */
export const RoleSchema = Type.String({
  minLength: 1,
  maxLength: ROLE_MAX_LENGTH,
  pattern: ROLE_PATTERN.source,
});

/**
 * An object with no member the protocol defines: `hello.capabilities`,
 * `error.details` and every JSON Schema document inside a catalog.
 *
 * `Type.Record` would emit `patternProperties`, which this wire never uses, so
 * open records are written by hand with `Type.Unsafe`.
 */
export const OpenObjectSchema = Type.Unsafe<Record<string, unknown>>({ type: 'object' });

/** Method names and event topics under this segment belong to the spec (§6.1). */
export const RPC_RESERVED_PREFIX = 'rpc.';

/** The reserved method that answers with the responder's catalog (§6.4). */
export const RPC_DISCOVER = 'rpc.discover';

/** Effective minor from which `rpc.discover` is part of the wire. */
export const RPC_DISCOVER_MINOR = 1;

/**
 * True when `value` is a reserved method this wire defines at `effectiveMinor`.
 * Every other `rpc.` name is refused with `INVALID_REQUEST`, including this one
 * against a 1.0 peer, which cannot have meant it.
 *
 * @example
 * isDefinedReservedMethod('rpc.discover', 1); // true
 * isDefinedReservedMethod('rpc.discover', 0); // false
 */
export function isDefinedReservedMethod(value: string, effectiveMinor: number): boolean {
  return value === RPC_DISCOVER && effectiveMinor >= RPC_DISCOVER_MINOR;
}

/**
 * True when `value` is a well-formed method name or event topic: at least two
 * dot-separated lowercase segments, at most 128 characters.
 *
 * @example
 * isValidMethodName('fs.read-file'); // true
 */
export function isValidMethodName(value: string): boolean {
  return value.length <= METHOD_MAX_LENGTH && METHOD_PATTERN.test(value);
}

/**
 * True when `value` sits under the reserved `rpc.` segment. Such a method is
 * schema-valid but a session answers it with `INVALID_REQUEST`; 1.0 defines
 * none.
 *
 * @example
 * isReservedMethodName('rpc.discover'); // true
 */
export function isReservedMethodName(value: string): boolean {
  return value.startsWith(RPC_RESERVED_PREFIX);
}

/** How much of a refused value an error message quotes. */
const PREVIEW_MAX_LENGTH = 120;

/** A short, safe rendering of a refused value. */
function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? `a ${typeof value} value`;
  } catch {
    text = `a ${typeof value} value that is not JSON-serialisable`;
  }
  return text.length <= PREVIEW_MAX_LENGTH ? text : `${text.slice(0, PREVIEW_MAX_LENGTH)}…`;
}

/**
 * Builds the message of a schema refusal: the first failing path, what that
 * member must be, and the value that arrived.
 *
 * @example
 * describeSchemaFailure('frame does not match the wire schema', FrameSchema, {});
 * // 'frame does not match the wire schema: the frame must have required properties type; received {}'
 */
export function describeSchemaFailure(subject: string, schema: TSchema, value: unknown): string {
  const [first] = Value.Errors(schema, value);
  const where = first === undefined || first.instancePath === '' ? '(root)' : first.instancePath;
  const detail = first?.message ?? 'is not valid';
  return `${subject}: ${where} ${detail}; received ${preview(value)}`;
}
