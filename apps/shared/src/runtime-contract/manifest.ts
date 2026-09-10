/**
 * What a runtime announces about itself in `hello.capabilities`, and what the
 * hub announces back.
 *
 * The manifest is an open object: an older hub keeps talking to a newer runtime
 * that advertises extra feature flags, and the contract passes this schema to
 * `defineContract` as its `capabilities` shape so both ends validate the same
 * announcement.
 */

import Type, { type Static } from 'typebox';
import {
  ExternalAgentTargetIdSchema,
  ExternalIdentityIsolationSchema,
} from '../external-agents/schemas';
import { MAX_DIRECTORY_HASH_DOMAIN_VERSION } from '../library/hash';
import { RuntimeCapabilityAllowSchema } from '../runtime-home/schemas';

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
  /**
   * The GitHub CLI on the target machine, for `gh.exec` / `gh.mutate`.
   *
   * Optional, and absent means **unavailable** — the `externalAgents` reading,
   * not the original `features` reading where absent means granted. A runtime
   * built before this key existed did not merely forget to answer: it never
   * ran the probe and does not carry the handlers, so treating silence as "yes"
   * would send it a method it will only refuse with `METHOD_UNSUPPORTED`.
   * Making the key required instead would fail decode for every older peer,
   * which costs the whole connection to learn one optional tool is missing.
   */
  gh: Type.Optional(
    Type.Object({
      available: Type.Boolean(),
      version: Type.Optional(Type.String({ minLength: 1 })),
    })
  ),
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
    /**
     * Whether spawn methods accept a `toolchain` selection. Absent means
     * false: `external-agent.open` validates its params strictly, so a hub
     * must not send the field to a peer built before it existed.
     */
    toolchain: Type.Optional(Type.Boolean()),
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
   * Whether this runtime can open an interactive PTY (`terminal.*`). Consent
   * *and* ability: false when the owner refused `shell`, when no shell is
   * present, or when the build has no PTY support. Absent means **unavailable**
   * — the `gh` reading, not the `features` one — because a peer built before
   * the key carries no `terminal.*` handlers and would only answer
   * `METHOD_UNSUPPORTED`.
   */
  terminal: Type.Optional(Type.Boolean()),
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
  /**
   * Whether this runtime re-checks the paths the hub names against the
   * {@link RuntimePathFilterSchema} the call carried.
   *
   * `pathPolicy` is optional on the wire so a hub can keep talking to a runtime
   * built before it existed. That tolerance is invisible on its own: an older
   * peer accepts the field, ignores it, and answers exactly like one that
   * enforced it. Declaring enforcement is what makes the difference legible, so
   * the hub can say which environment is running unchecked rather than assume.
   *
   * Absent means **false** — like `acceptsHubIdentity` and unlike the `features`
   * keys, where absent means granted. A peer that does not answer the question
   * has not answered it in the affirmative.
   */
  enforcesPathPolicy: Type.Optional(Type.Boolean()),
  /**
   * Whether this runtime can publish new slot bytes on Windows.
   *
   * Live update refused win32 outright until side-by-side version directories
   * gained a junction pointer, and a hub cannot tell the two builds apart from
   * a version string alone — a peer can be older than the hub talking to it.
   * Without this the environment card would offer an upgrade that the far side
   * refuses the instant somebody presses it.
   *
   * Absent means **false**, like {@link enforcesPathPolicy} and unlike the
   * `features` keys. Meaningless off Windows, where publication never needed a
   * declaration, and read only when `platform` is `win32`.
   */
  publishesWindowsSlot: Type.Optional(Type.Boolean()),
  /**
   * Which directory-hash domain this runtime computes. A version, not a boolean:
   * the domain is monotonic and will move again, and a v3 must not need a new
   * field.
   *
   * Directory hashes are not comparable across a domain boundary. File-backed
   * resources are unaffected — only the directory domain moved. Absent means
   * **v2**: that domain shipped before this field, so a parent-revision peer
   * already computes it. Unlike `enforcesPathPolicy`, silence is not the
   * pre-fix default.
   */
  directoryHashDomain: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_DIRECTORY_HASH_DOMAIN_VERSION })
  ),
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

/**
 * Who is speaking for the hub on this connection. Additive-optional: older
 * hubs omit it, and the runtime's audit log records those as an unidentified
 * hub rather than refusing the handshake.
 */
export const HubIdentitySchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 255 }),
    user: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false }
);
export type HubIdentity = Static<typeof HubIdentitySchema>;
