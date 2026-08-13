import Type, { type Static } from 'typebox';
import {
  ExternalAgentTargetIdSchema,
  ExternalIdentityIsolationSchema,
} from '../external-agents/schemas';
import { RuntimeCapabilityAllowSchema } from '../runtime-home/schemas';

/** Protocol version shared by every transport in this release. */
export const RUNTIME_PROTOCOL_VERSION = '1.0.1' as const;

export const RuntimeProtocolVersionSchema = Type.String({
  minLength: 3,
  maxLength: 32,
  pattern: '^\\d+\\.\\d+(?:\\.\\d+)?$',
});
export type RuntimeProtocolVersion = Static<typeof RuntimeProtocolVersionSchema>;

export const RuntimeErrorCodeSchema = Type.Union([
  Type.Literal('RUNTIME_UNAVAILABLE'),
  Type.Literal('METHOD_UNSUPPORTED'),
  Type.Literal('PROTOCOL_MISMATCH'),
  Type.Literal('CANCELLED'),
  Type.Literal('TIMEOUT'),
  Type.Literal('INTERNAL'),
  /** The machine's owner has not granted a capability the method needs. */
  Type.Literal('RUNTIME_DENIED'),
  /** A live binary transfer was unsafe, malformed, busy, or out of sequence. */
  Type.Literal('RUNTIME_UPDATE_REFUSED'),
]);
export type RuntimeErrorCode = Static<typeof RuntimeErrorCodeSchema>;

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

const KNOWN_RUNTIME_ERROR_CODES = new Set<string>(
  RuntimeErrorCodeSchema.anyOf.map((entry) => entry.const)
);

/**
 * Map a wire error code onto the known union. A code this build has never
 * heard of is a policy refusal from the future (or a typo); treating either as
 * a protocol violation would drop the connection instead of surfacing a state.
 */
export function narrowRuntimeErrorCode(code: string): RuntimeErrorCode {
  return KNOWN_RUNTIME_ERROR_CODES.has(code) ? (code as RuntimeErrorCode) : 'INTERNAL';
}

export const RuntimeShellKindSchema = Type.Union([
  Type.Literal('bash'),
  Type.Literal('zsh'),
  Type.Literal('powershell'),
]);
export type RuntimeShellKind = Static<typeof RuntimeShellKindSchema>;

/**
 * Capability announcement in `hello`. Manifest objects tolerate unknown keys
 * so an older hub can keep talking to a newer runtime that advertises extra
 * feature flags; frame envelopes themselves stay closed.
 *
 * Feature keys beyond the original six are optional: an absent value means the
 * peer predates the key and should be treated as granted (`true`) so an older
 * runtime is not silently stripped of tools the hub already trusted.
 */
export const RuntimeCapabilityManifestSchema = Type.Object({
  platform: Type.String({ minLength: 1 }),
  arch: Type.String({ minLength: 1 }),
  pathStyle: Type.Union([Type.Literal('posix'), Type.Literal('win32')]),
  homeDir: Type.String({ minLength: 1 }),
  shells: Type.Array(RuntimeShellKindSchema, { uniqueItems: true }),
  git: Type.Object({
    available: Type.Boolean(),
    version: Type.Optional(Type.String({ minLength: 1 })),
  }),
  features: Type.Object({
    tools: Type.Boolean(),
    git: Type.Boolean(),
    probing: Type.Boolean(),
    mcp: Type.Boolean(),
    library: Type.Boolean(),
    checkpoints: Type.Boolean(),
    /** Absent on older peers — treat as true. */
    fsRead: Type.Optional(Type.Boolean()),
    fsWrite: Type.Optional(Type.Boolean()),
    shell: Type.Optional(Type.Boolean()),
    update: Type.Optional(Type.Boolean()),
    /**
     * Privileged vendor-process hosting. Absent means false: a peer predating
     * this key cannot safely be assumed to support or have consent for it.
     */
    externalAgents: Type.Optional(Type.Boolean()),
  }),
  /**
   * Targets backed by adapters in this runtime. Absent means none; an older
   * runtime genuinely cannot host an adapter it did not ship.
   */
  externalAgents: Type.Optional(
    Type.Array(ExternalAgentTargetIdSchema, {
      maxItems: ExternalAgentTargetIdSchema.anyOf.length,
      uniqueItems: true,
    })
  ),
  /** Positive attestation of per-user vendor credential isolation; absent is unproven. */
  identityIsolation: Type.Optional(ExternalIdentityIsolationSchema),
  /**
   * Whether this runtime's frame decoder knows the `hub` field on `hello_ack`.
   *
   * Frame envelopes are closed, so a hub that sends `hub` to a runtime built
   * before the field existed fails that peer's decode and drops the socket.
   * The manifest is the tolerant surface, and it arrives on `hello` before the
   * hub answers — so the hub asks here first and stays silent when the answer
   * is absent. Absent means **false** (an older peer), unlike the `features`
   * keys, where absent means granted.
   */
  acceptsHubIdentity: Type.Optional(Type.Boolean()),
  /** Consent profile that produced `features`; absent on older peers. */
  profile: Type.Optional(
    Type.Union([
      Type.Literal('full'),
      Type.Literal('readonly'),
      Type.Literal('none'),
      Type.Literal('custom'),
    ])
  ),
  /**
   * What the machine's owner granted, before intersection with what the
   * machine actually has. `features` alone cannot answer "did someone refuse
   * this, or is the binary just missing?" — `git` is false either way — and a
   * UI that reads a refusal into an absent git tells the owner they denied
   * something they did not. Absent on older peers; a consumer that needs the
   * distinction must handle its absence rather than assume a refusal.
   */
  allow: Type.Optional(RuntimeCapabilityAllowSchema),
});
export type RuntimeCapabilityManifest = Static<typeof RuntimeCapabilityManifestSchema>;

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

/**
 * Who is speaking for the hub on this connection. Additive-optional: older
 * hubs omit it, and the runtime's audit log records those as an unidentified
 * hub rather than refusing the handshake.
 */
export const RuntimeHubIdentitySchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 255 }),
    user: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false }
);
export type RuntimeHubIdentity = Static<typeof RuntimeHubIdentitySchema>;

export const RuntimeHelloAckFrameSchema = Type.Object(
  {
    type: Type.Literal('hello_ack'),
    protocolVersion: RuntimeProtocolVersionSchema,
    hubVersion: Type.String({ minLength: 1, maxLength: 128 }),
    hub: Type.Optional(RuntimeHubIdentitySchema),
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
