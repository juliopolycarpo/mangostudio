import Type, { type Static } from 'typebox';
import {
  narrowRuntimeErrorCode,
  type RuntimeErrorCode,
  RuntimeErrorCodeSchema,
} from '../runtime-contract/errors';
import {
  type HubIdentity,
  HubIdentitySchema,
  type RuntimeCapabilityManifest,
  RuntimeCapabilityManifestSchema,
  type RuntimeShellKind,
  RuntimeShellKindSchema,
} from '../runtime-contract/manifest';
import {
  type RuntimePathFilter,
  RuntimePathFilterSchema,
  type RuntimePathPolicyParams,
  RuntimePathPolicyParamsSchema,
} from '../runtime-contract/path-policy';

/**
 * The moved half of this module, kept reachable under its old name while the
 * transports still speak the hand-written framing. `runtime-contract` owns
 * these now; this file owns only the frame envelopes and the codec's view of
 * `err.code`.
 */
export {
  type HubIdentity as RuntimeHubIdentity,
  HubIdentitySchema as RuntimeHubIdentitySchema,
  narrowRuntimeErrorCode,
  type RuntimeCapabilityManifest,
  RuntimeCapabilityManifestSchema,
  type RuntimeErrorCode,
  RuntimeErrorCodeSchema,
  type RuntimePathFilter,
  RuntimePathFilterSchema,
  type RuntimePathPolicyParams,
  RuntimePathPolicyParamsSchema,
  type RuntimeShellKind,
  RuntimeShellKindSchema,
};

/** Protocol version shared by every transport in this release. */
export const RUNTIME_PROTOCOL_VERSION = '1.0.1' as const;

export const RuntimeProtocolVersionSchema = Type.String({
  minLength: 3,
  maxLength: 32,
  pattern: '^\\d+\\.\\d+(?:\\.\\d+)?$',
});
export type RuntimeProtocolVersion = Static<typeof RuntimeProtocolVersionSchema>;

/**
 * Wire form of `err.code`: open so a newer peer's refusal (or any future
 * literal) does not tear the socket down. Consumers narrow with
 * {@link narrowRuntimeErrorCode}; unknown codes degrade to `INTERNAL`.
 */
export const RuntimeWireErrorCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Z][A-Z0-9_]*$',
});
export type RuntimeWireErrorCode = Static<typeof RuntimeWireErrorCodeSchema>;

const RuntimeFrameIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const RuntimeMethodSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$',
});
const RuntimeTopicSchema = Type.String({ minLength: 1, maxLength: 256 });

/**
 * Topic a runtime publishes on while it is connected. It is a keep-alive with
 * a payload, not a metric: the hub uses it to record that a credential is in
 * use without writing on every protocol ping.
 */
export const RUNTIME_HEARTBEAT_TOPIC = 'runtime.heartbeat' as const;

export const RuntimeHelloFrameSchema = Type.Object(
  {
    type: Type.Literal('hello'),
    protocolVersion: RuntimeProtocolVersionSchema,
    runtimeVersion: Type.String({ minLength: 1, maxLength: 128 }),
    manifest: RuntimeCapabilityManifestSchema,
  },
  { additionalProperties: false }
);
export type RuntimeHelloFrame = Static<typeof RuntimeHelloFrameSchema>;

export const RuntimeHelloAckFrameSchema = Type.Object(
  {
    type: Type.Literal('hello_ack'),
    protocolVersion: RuntimeProtocolVersionSchema,
    hubVersion: Type.String({ minLength: 1, maxLength: 128 }),
    hub: Type.Optional(HubIdentitySchema),
  },
  { additionalProperties: false }
);
export type RuntimeHelloAckFrame = Static<typeof RuntimeHelloAckFrameSchema>;

export const RuntimeRequestFrameSchema = Type.Object(
  {
    type: Type.Literal('req'),
    id: RuntimeFrameIdSchema,
    method: RuntimeMethodSchema,
    params: Type.Unknown(),
  },
  { additionalProperties: false }
);
export type RuntimeRequestFrame = Static<typeof RuntimeRequestFrameSchema>;

export const RuntimeSuccessResponseFrameSchema = Type.Object(
  {
    type: Type.Literal('res'),
    id: RuntimeFrameIdSchema,
    ok: Type.Unknown(),
  },
  { additionalProperties: false }
);
export type RuntimeSuccessResponseFrame = Static<typeof RuntimeSuccessResponseFrameSchema>;

export const RuntimeErrorPayloadSchema = Type.Object(
  {
    code: RuntimeWireErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false }
);
export type RuntimeErrorPayload = Static<typeof RuntimeErrorPayloadSchema>;

export const RuntimeErrorResponseFrameSchema = Type.Object(
  {
    type: Type.Literal('res'),
    id: RuntimeFrameIdSchema,
    err: RuntimeErrorPayloadSchema,
  },
  { additionalProperties: false }
);
export type RuntimeErrorResponseFrame = Static<typeof RuntimeErrorResponseFrameSchema>;

export const RuntimeResponseFrameSchema = Type.Union([
  RuntimeSuccessResponseFrameSchema,
  RuntimeErrorResponseFrameSchema,
]);
export type RuntimeResponseFrame = Static<typeof RuntimeResponseFrameSchema>;

export const RuntimeEventFrameSchema = Type.Object(
  {
    type: Type.Literal('evt'),
    topic: RuntimeTopicSchema,
    seq: Type.Integer({ minimum: 0 }),
    streamId: Type.Optional(RuntimeFrameIdSchema),
    payload: Type.Unknown(),
    end: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false }
);
export type RuntimeEventFrame = Static<typeof RuntimeEventFrameSchema>;

export const RuntimeCancelFrameSchema = Type.Object(
  {
    type: Type.Literal('cancel'),
    id: RuntimeFrameIdSchema,
  },
  { additionalProperties: false }
);
export type RuntimeCancelFrame = Static<typeof RuntimeCancelFrameSchema>;

export const RuntimePingFrameSchema = Type.Object(
  {
    type: Type.Literal('ping'),
  },
  { additionalProperties: false }
);
export type RuntimePingFrame = Static<typeof RuntimePingFrameSchema>;

export const RuntimePongFrameSchema = Type.Object(
  {
    type: Type.Literal('pong'),
  },
  { additionalProperties: false }
);
export type RuntimePongFrame = Static<typeof RuntimePongFrameSchema>;

export const RuntimeFrameSchema = Type.Union([
  RuntimeHelloFrameSchema,
  RuntimeHelloAckFrameSchema,
  RuntimeRequestFrameSchema,
  RuntimeResponseFrameSchema,
  RuntimeEventFrameSchema,
  RuntimeCancelFrameSchema,
  RuntimePingFrameSchema,
  RuntimePongFrameSchema,
]);
export type RuntimeFrame = Static<typeof RuntimeFrameSchema>;
