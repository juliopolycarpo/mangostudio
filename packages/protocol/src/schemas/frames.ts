/**
 * The nine wire frames of Mango Protocol 1, mirroring
 * spec/schema/1/protocol.json member for member.
 *
 * Every object is open: a decoder ignores members it does not know, so no
 * schema sets `additionalProperties`. `params`, `result` and `payload` are any
 * JSON value, including `null`.
 */

import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { CodecError } from '../errors';
import {
  CLOSE_REASON_MAX_LENGTH,
  CloseCodeSchema,
  describeSchemaFailure,
  ErrorCodeSchema,
  IdSchema,
  MethodSchema,
  OpenObjectSchema,
  PEER_FIELD_MAX_LENGTH,
  RoleSchema,
  TopicSchema,
} from './common';

/** Smallest frame limit a peer may announce (§11). */
const MIN_ANNOUNCED_FRAME_BYTES = 4096;

/** Largest frame limit `hello.limits` can carry, one signed 32-bit integer. */
const MAX_ANNOUNCED_FRAME_BYTES = 2147483647;

/** Fewest requests a peer may announce it will hold open (§11.2). */
export const MIN_ANNOUNCED_IN_FLIGHT = 1;

/** Largest in-flight ceiling `hello.limits` can carry, one signed 32-bit integer. */
const MAX_ANNOUNCED_IN_FLIGHT = 2147483647;

/** `hello.protocol`: the wire version a peer speaks. */
export const ProtocolVersionSchema = Type.Object({
  major: Type.Integer({ minimum: 1 }),
  minor: Type.Integer({ minimum: 0 }),
});

/** `hello.peer`: who the implementation is. */
export const PeerInfoSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: PEER_FIELD_MAX_LENGTH }),
  version: Type.String({ minLength: 1, maxLength: PEER_FIELD_MAX_LENGTH }),
  role: RoleSchema,
});
export type PeerInfo = Static<typeof PeerInfoSchema>;

/** `hello.limits`: the ceilings this peer will accept. */
export const LimitsSchema = Type.Object({
  maxFrameBytes: Type.Optional(
    Type.Integer({ minimum: MIN_ANNOUNCED_FRAME_BYTES, maximum: MAX_ANNOUNCED_FRAME_BYTES })
  ),
  maxInFlight: Type.Optional(
    Type.Integer({ minimum: MIN_ANNOUNCED_IN_FLIGHT, maximum: MAX_ANNOUNCED_IN_FLIGHT })
  ),
});
export type Limits = Static<typeof LimitsSchema>;

/** `hello.capabilities`: owned by the application contract, `{}` is valid. */
export const CapabilitiesSchema = Type.Unsafe<Record<string, unknown>>({
  type: 'object',
  description: 'Owned by the application contract; the protocol defines no member.',
});

/** `err.error`: a string code, a sentence and optional typed detail. */
export const ErrorPayloadSchema = Type.Object({
  code: ErrorCodeSchema,
  message: Type.String({ minLength: 1 }),
  details: Type.Optional(OpenObjectSchema),
});
export type ErrorPayload = Static<typeof ErrorPayloadSchema>;

/** Handshake; both peers send one as soon as the transport opens. */
export const HelloFrameSchema = Type.Object(
  {
    type: Type.Literal('hello'),
    protocol: ProtocolVersionSchema,
    peer: PeerInfoSchema,
    capabilities: CapabilitiesSchema,
    limits: Type.Optional(LimitsSchema),
  },
  { description: 'Handshake; both peers send one as soon as the transport opens.' }
);
export type HelloFrame = Static<typeof HelloFrameSchema>;

/** Request. Exactly one `res` or `err` answers it. */
export const RequestFrameSchema = Type.Object(
  {
    type: Type.Literal('req'),
    id: IdSchema,
    method: MethodSchema,
    params: Type.Unknown(),
  },
  { description: 'Request. Exactly one res or err answers it.' }
);
export type RequestFrame = Static<typeof RequestFrameSchema>;

/** Successful response. */
export const ResultFrameSchema = Type.Object(
  {
    type: Type.Literal('res'),
    id: IdSchema,
    result: Type.Unknown(),
  },
  { description: 'Successful response.' }
);
export type ResultFrame = Static<typeof ResultFrameSchema>;

/** Failed response. */
export const ErrorFrameSchema = Type.Object(
  {
    type: Type.Literal('err'),
    id: IdSchema,
    error: ErrorPayloadSchema,
  },
  { description: 'Failed response.' }
);
export type ErrorFrame = Static<typeof ErrorFrameSchema>;

/** Event; `seq` counts per stream key (`streamId`, else `topic`). */
export const EventFrameSchema = Type.Object(
  {
    type: Type.Literal('evt'),
    topic: TopicSchema,
    seq: Type.Integer({ minimum: 0 }),
    streamId: Type.Optional(IdSchema),
    payload: Type.Unknown(),
    end: Type.Optional(Type.Literal(true)),
  },
  { description: 'Event; seq counts per stream key (streamId, else topic).' }
);
export type EventFrame = Static<typeof EventFrameSchema>;

/** Advisory request to stop; the original response still follows. */
export const CancelFrameSchema = Type.Object(
  {
    type: Type.Literal('cancel'),
    id: IdSchema,
  },
  { description: 'Advisory request to stop; the original response still follows.' }
);
export type CancelFrame = Static<typeof CancelFrameSchema>;

/** Liveness probe. */
export const PingFrameSchema = Type.Object(
  { type: Type.Literal('ping') },
  { description: 'Liveness probe.' }
);
export type PingFrame = Static<typeof PingFrameSchema>;

/** Liveness answer. */
export const PongFrameSchema = Type.Object(
  { type: Type.Literal('pong') },
  { description: 'Liveness answer.' }
);
export type PongFrame = Static<typeof PongFrameSchema>;

/** Farewell sent before the transport closes. */
export const CloseFrameSchema = Type.Object(
  {
    type: Type.Literal('close'),
    code: CloseCodeSchema,
    reason: Type.Optional(Type.String({ maxLength: CLOSE_REASON_MAX_LENGTH })),
  },
  { description: 'Farewell sent before the transport closes.' }
);
export type CloseFrame = Static<typeof CloseFrameSchema>;

/** Every frame a Mango Protocol 1 peer may send. */
export const FrameSchema = Type.Union([
  HelloFrameSchema,
  RequestFrameSchema,
  ResultFrameSchema,
  ErrorFrameSchema,
  EventFrameSchema,
  CancelFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
  CloseFrameSchema,
]);
export type Frame = Static<typeof FrameSchema>;

/** The `type` member of a frame, the discriminator of the union. */
export type FrameType = Frame['type'];

/** One schema per frame type, so a refusal reports the branch that was meant. */
const FRAME_SCHEMAS = {
  hello: HelloFrameSchema,
  req: RequestFrameSchema,
  res: ResultFrameSchema,
  err: ErrorFrameSchema,
  evt: EventFrameSchema,
  cancel: CancelFrameSchema,
  ping: PingFrameSchema,
  pong: PongFrameSchema,
  close: CloseFrameSchema,
} as const;

const FRAME_TYPES: readonly string[] = Object.keys(FRAME_SCHEMAS);

/** The `type` member of a decoded object, when it carries a string one. */
function frameTypeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const type: unknown = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function branchFor(type: string | undefined): (typeof FRAME_SCHEMAS)[FrameType] | undefined {
  if (type === undefined || !Object.hasOwn(FRAME_SCHEMAS, type)) return undefined;
  return FRAME_SCHEMAS[type as FrameType];
}

/**
 * True when `value` is a frame this wire major defines. Unknown members are
 * ignored, as §4 requires.
 *
 * @example
 * isFrame({ type: 'ping' }); // true
 */
export function isFrame(value: unknown): value is Frame {
  return Value.Check(FrameSchema, value);
}

/**
 * Narrows `value` to a `Frame` or throws a `CodecError` of kind `schema` naming
 * the member that failed and the value received. The refusal carries the frame
 * type when the value declared one, so a transport can pick its close code.
 *
 * @example
 * assertFrame(JSON.parse(line)); // throws CodecError('schema', ...) on a bad frame
 */
export function assertFrame(value: unknown): asserts value is Frame {
  if (isFrame(value)) return;

  const frameType = frameTypeOf(value);
  const options = frameType === undefined ? undefined : { frameType };
  const branch = branchFor(frameType);
  if (frameType !== undefined && branch === undefined) {
    throw new CodecError(
      'schema',
      `unknown frame type ${JSON.stringify(frameType)}; expected one of ${FRAME_TYPES.join(', ')}`,
      options
    );
  }

  const message = describeSchemaFailure(
    'frame does not match the wire schema',
    branch ?? FrameSchema,
    value
  );
  throw new CodecError('schema', message, options);
}
