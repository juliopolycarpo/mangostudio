/**
 * The `external-agents` bounded context.
 *
 * An external agent is a vendor CLI — Codex, Cursor, Claude Code — that owns
 * its own authentication, model choice, context, tools, permissions, sandbox
 * and approvals. MangoStudio discovers it, relays input, renders normalized
 * events and cancels. Nothing here describes work MangoStudio performs.
 *
 * The invariant every shape in this file serves:
 *
 * > External agents never own MangoStudio tools. They use their own tools, and
 * > MangoStudio only surfaces them in the interface.
 *
 * That is why the tool-shaped events below are called `activity`: they are
 * observational. Nothing in this contract can be handed to a tool executor,
 * because nothing in it names a MangoStudio tool.
 *
 * Keep this module browser-safe — no Node builtins, directly or transitively.
 * The frontend imports `@mangostudio/shared/external-agents`, and a builtin
 * here renders an empty page while `check`, `test` and `build` stay green.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';
import {
  EXTERNAL_APPROVAL_MAX_OPTIONS,
  type ExternalTextLimit,
  schemaMaxLengthFor,
} from './vendor-text';

/**
 * Vendor-supplied text, bounded.
 *
 * The exact bound is applied at the runtime boundary by `boundVendorText`,
 * which counts code points. JSON Schema's `maxLength` is evaluated by TypeBox
 * against `String.prototype.length`, i.e. UTF-16 units, so the schema bound is
 * the code-point limit doubled: a correctly bounded string can never be
 * rejected here, and an unbounded one is still refused before it is persisted.
 */
function VendorText(limit: ExternalTextLimit, options?: { minLength?: number }) {
  return Type.String({ ...options, maxLength: schemaMaxLengthFor(limit) });
}

/**
 * Which external agent. Exactly `Exclude<LibraryTargetId, 'mangostudio'>`,
 * restated rather than derived so this context does not depend on `library`;
 * `tests/unit/external-agents.test.ts` holds both halves together with a
 * compile-time equality assertion and a runtime parity check.
 */
export const ExternalAgentTargetIdSchema = Type.Union([
  Type.Literal('codex'),
  Type.Literal('cursor'),
  Type.Literal('claude'),
]);

export type ExternalAgentTargetId = Static<typeof ExternalAgentTargetIdSchema>;

export const EXTERNAL_AGENT_TARGET_IDS: readonly ExternalAgentTargetId[] =
  ExternalAgentTargetIdSchema.anyOf.map((literal) => literal.const);

/**
 * Narrows a string that may or may not name a vendor.
 *
 * Both sides of the wire need this and neither may keep its own list: the hub
 * reads a `runnerTargetId` column that predates any given target, and the chat
 * feed reads a stored `modelName` that falls back to the bare target id. A copy
 * that fell behind {@link ExternalAgentTargetIdSchema} would reject a value this
 * same schema had already accepted on write.
 */
export function isExternalAgentTargetId(value: string): value is ExternalAgentTargetId {
  return EXTERNAL_AGENT_TARGET_IDS.some((targetId) => targetId === value);
}

/**
 * What an adapter can actually do.
 *
 * Nothing is true by default. A flag is the adapter's way of refusing to fake
 * parity, so the hub never declares one on an adapter's behalf — these are
 * filled in by the adapter that would run the turn, and an old runtime paired
 * with a new hub therefore reports what it really supports.
 */
export const ExternalAgentCapabilitiesSchema = Type.Object(
  {
    /** A parseable event stream, not a text transcript to scrape. */
    structuredStreaming: Type.Boolean(),
    reasoningStream: Type.Boolean(),
    /** A real request/response exchange, not a prompt written to a TTY. */
    interactiveApprovals: Type.Boolean(),
    resume: Type.Boolean(),
    modelCatalog: Type.Boolean(),
    images: Type.Boolean(),
    usageReporting: Type.Boolean(),
    cancellation: Type.Boolean(),
    /** Same-turn steering, not a queued follow-up message. */
    steering: Type.Boolean(),
    sessionListing: Type.Boolean(),
    nativeReview: Type.Boolean(),
    accountUsage: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type ExternalAgentCapabilities = Static<typeof ExternalAgentCapabilitiesSchema>;

/**
 * What the hub reports before any adapter has answered.
 *
 * Every flag false is the only honest answer with no adapter in the loop, which
 * is what the cheap discovery pass has: it can see a binary on disk, not what
 * that binary is willing to do.
 */
export const NO_EXTERNAL_AGENT_CAPABILITIES: ExternalAgentCapabilities = {
  structuredStreaming: false,
  reasoningStream: false,
  interactiveApprovals: false,
  resume: false,
  modelCatalog: false,
  images: false,
  usageReporting: false,
  cancellation: false,
  steering: false,
  sessionListing: false,
  nativeReview: false,
  accountUsage: false,
};

/**
 * What the agent is allowed to do. One of the two permission axes.
 *
 * This union is closed, deliberately: it is an API shape, and versioning it is
 * a decision rather than an accident. The database columns that persist a
 * choice are `TEXT` and forward-compatible, and the read path normalizes an
 * unrecognized value to the restrictive end — see `normalizePermissionLevel`.
 */
export const ExternalPermissionLevelSchema = Type.Union([
  Type.Literal('read-only'),
  Type.Literal('default'),
  Type.Literal('full-access'),
]);

export type ExternalPermissionLevel = Static<typeof ExternalPermissionLevelSchema>;

export const EXTERNAL_PERMISSION_LEVELS: readonly ExternalPermissionLevel[] =
  ExternalPermissionLevelSchema.anyOf.map((literal) => literal.const);

/** Who answers the agent's approval prompts. The second permission axis. */
export const ExternalApprovalRoutingSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('auto-review'),
]);

export type ExternalApprovalRouting = Static<typeof ExternalApprovalRoutingSchema>;

export const EXTERNAL_APPROVAL_ROUTINGS: readonly ExternalApprovalRouting[] =
  ExternalApprovalRoutingSchema.anyOf.map((literal) => literal.const);

/**
 * One (level, routing) pair, as vetted by the adapter that would run it.
 *
 * The axes are product vocabulary; they are not freely composable everywhere.
 * Codex keeps them as separate fields, Cursor exposes session modes, and Claude
 * collapses both onto one account-gated flag. So the adapter returns the
 * combinations it supports and the UI renders that list — it never composes two
 * independent controls into a pair no adapter offered.
 */
export const ExternalSupportedConfigurationSchema = Type.Object(
  {
    level: ExternalPermissionLevelSchema,
    routing: ExternalApprovalRoutingSchema,
    supported: Type.Boolean(),
    /** i18n key explaining the refusal. Present only when `supported` is false. */
    unsupportedReasonKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** The vendor's own id for this combination, when discovered rather than declared. */
    vendorId: Type.Optional(VendorText('vendorId', { minLength: 1 })),
    /** True when choosing this lets the agent act without asking. Drives the UI warning. */
    unattended: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type ExternalSupportedConfiguration = Static<typeof ExternalSupportedConfigurationSchema>;

export const ExternalSupportedConfigurationListSchema = ReadonlyArraySchema(
  ExternalSupportedConfigurationSchema,
  { maxItems: EXTERNAL_PERMISSION_LEVELS.length * EXTERNAL_APPROVAL_ROUTINGS.length }
);

/** How a runtime proves that vendor credentials cannot cross MangoStudio users. */
export const ExternalIdentityIsolationSchema = Type.Object(
  {
    method: Type.Union([
      Type.Literal('single-user-host'),
      Type.Literal('os-account'),
      Type.Literal('container'),
    ]),
    /** Opaque, non-reversible digest used only to detect a changed credential home. */
    credentialHomeFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false }
);

export type ExternalIdentityIsolation = Static<typeof ExternalIdentityIsolationSchema>;

/** One vendor-defined reasoning choice retained without flattening it to a MangoStudio enum. */
export const ExternalAgentReasoningEffortSchema = Type.Object(
  {
    id: VendorText('vendorId', { minLength: 1 }),
    displayName: Type.Optional(VendorText('title', { minLength: 1 })),
    description: Type.Optional(VendorText('detail')),
  },
  { additionalProperties: false }
);

export type ExternalAgentReasoningEffort = Static<typeof ExternalAgentReasoningEffortSchema>;

/** A model as the vendor advertised it, including the per-model reasoning catalog. */
export const ExternalAgentModelSchema = Type.Object(
  {
    id: VendorText('vendorId', { minLength: 1 }),
    displayName: Type.Optional(VendorText('title', { minLength: 1 })),
    description: Type.Optional(VendorText('detail')),
    isDefault: Type.Optional(Type.Boolean()),
    hidden: Type.Optional(Type.Boolean()),
    inputModalities: Type.Optional(
      ReadonlyArraySchema(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: 16,
        uniqueItems: true,
      })
    ),
    supportedReasoningEfforts: Type.Optional(
      ReadonlyArraySchema(ExternalAgentReasoningEffortSchema, {
        maxItems: 32,
        uniqueItems: true,
      })
    ),
    defaultReasoningEffort: Type.Optional(VendorText('vendorId', { minLength: 1 })),
    serviceTiers: Type.Optional(
      ReadonlyArraySchema(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 32,
        uniqueItems: true,
      })
    ),
  },
  { additionalProperties: false }
);

export type ExternalAgentModel = Static<typeof ExternalAgentModelSchema>;

export const ExternalAgentModelCatalogSchema = ReadonlyArraySchema(ExternalAgentModelSchema, {
  maxItems: 256,
});

/** Settings that can be changed between turns without adopting a new session. */
export const ExternalAgentConfigurationSchema = Type.Object(
  {
    model: Type.Optional(VendorText('vendorId', { minLength: 1 })),
    effort: Type.Optional(VendorText('vendorId', { minLength: 1 })),
    level: ExternalPermissionLevelSchema,
    routing: ExternalApprovalRoutingSchema,
    workspaceRoots: ReadonlyArraySchema(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export type ExternalAgentConfiguration = Static<typeof ExternalAgentConfigurationSchema>;

/** Bytes for one hub-owned attachment crossing to the machine that runs the vendor. */
export const ExternalAgentAttachmentSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    originalName: Type.String({ minLength: 1, maxLength: 512 }),
    mimeType: Type.String({ minLength: 1, maxLength: 255 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: 2 * 1024 * 1024 }),
    kind: Type.Union([
      Type.Literal('image'),
      Type.Literal('text'),
      Type.Literal('pdf'),
      Type.Literal('data'),
      Type.Literal('unknown'),
    ]),
    bytesBase64: Type.String({ minLength: 1, maxLength: 2_796_204 }),
  },
  { additionalProperties: false }
);

export type ExternalAgentAttachment = Static<typeof ExternalAgentAttachmentSchema>;

/**
 * A neutral icon bucket for a vendor activity, derived from Codex's 18-member
 * `ThreadItem` union and kept small enough that every vendor can map onto it.
 *
 * It picks an icon and nothing else. `userMessage`, `agentMessage` and
 * `reasoning` are *not* activity — they are `text_delta` and `reasoning_delta`.
 * Codex's `dynamicToolCall` is the host-tool item and must never map to
 * anything that reads as executable.
 */
export const ExternalActivityKindSchema = Type.Union([
  Type.Literal('command'),
  Type.Literal('file-change'),
  Type.Literal('mcp'),
  Type.Literal('subagent'),
  Type.Literal('web-search'),
  Type.Literal('image'),
  Type.Literal('plan'),
  Type.Literal('review'),
  Type.Literal('compaction'),
  Type.Literal('other'),
]);

export type ExternalActivityKind = Static<typeof ExternalActivityKindSchema>;

export const EXTERNAL_ACTIVITY_KINDS: readonly ExternalActivityKind[] =
  ExternalActivityKindSchema.anyOf.map((literal) => literal.const);

/**
 * What the vendor is doing, as something to render.
 *
 * `name` is the vendor's own tool name, verbatim. It is the pill label, so it
 * is never normalized, prettified or translated — and it is rendered as plain
 * text, never as markdown or HTML.
 */
export const ExternalActivityViewSchema = Type.Object(
  {
    name: VendorText('activityName', { minLength: 1 }),
    kind: ExternalActivityKindSchema,
    title: VendorText('title'),
    detail: Type.Optional(VendorText('detail')),
    /** True when any field above was cut to fit its bound. */
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ExternalActivityView = Static<typeof ExternalActivityViewSchema>;

export const ExternalActivityUpdateSchema = Type.Object(
  {
    title: Type.Optional(VendorText('title')),
    detail: Type.Optional(VendorText('detail')),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ExternalActivityUpdate = Static<typeof ExternalActivityUpdateSchema>;

export const ExternalActivityStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

export type ExternalActivityStatus = Static<typeof ExternalActivityStatusSchema>;

export const ExternalActivityResultSchema = Type.Object(
  {
    status: ExternalActivityStatusSchema,
    detail: Type.Optional(VendorText('detail')),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ExternalActivityResult = Static<typeof ExternalActivityResultSchema>;

/**
 * One choice the vendor offered.
 *
 * The option set is passed through untouched: MangoStudio never adds, removes,
 * reorders or renames a choice. When the vendor supplied label text it lands in
 * `rawLabel` and is rendered as plain text; `labelKey` is only for options
 * MangoStudio itself recognizes by id.
 */
export const ExternalApprovalOptionSchema = Type.Object(
  {
    id: VendorText('vendorId', { minLength: 1 }),
    labelKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    rawLabel: Type.Optional(VendorText('approvalOptionLabel')),
    isDestructive: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type ExternalApprovalOption = Static<typeof ExternalApprovalOptionSchema>;

export const ExternalApprovalRequestSchema = Type.Object(
  {
    requestId: VendorText('vendorId', { minLength: 1 }),
    kind: ExternalActivityKindSchema,
    title: VendorText('title'),
    detail: Type.Optional(VendorText('detail')),
    options: ReadonlyArraySchema(ExternalApprovalOptionSchema, {
      minItems: 1,
      maxItems: EXTERNAL_APPROVAL_MAX_OPTIONS,
    }),
    /** Every approval expires; an unanswered one must not hold a turn open forever. */
    expiresAtMs: Type.Integer({ minimum: 0 }),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ExternalApprovalRequest = Static<typeof ExternalApprovalRequestSchema>;

export const ExternalApprovalDecisionSchema = Type.Object(
  {
    optionId: VendorText('vendorId', { minLength: 1 }),
    /** How the answer was produced, for the audit trail the UI shows. */
    source: Type.Union([
      Type.Literal('user'),
      Type.Literal('auto-review'),
      Type.Literal('expired'),
      Type.Literal('cancelled'),
    ]),
  },
  { additionalProperties: false }
);

export type ExternalApprovalDecision = Static<typeof ExternalApprovalDecisionSchema>;

/** Tokens, as reported. Every field optional: adapters report only what their vendor reports. */
export const ExternalUsageSchema = Type.Object(
  {
    inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

export type ExternalUsage = Static<typeof ExternalUsageSchema>;

/**
 * Cumulative thread usage as Codex reports it: separate `last` (this turn) and
 * `total` (the whole thread). The two must never be collapsed — a per-turn
 * display that read `total` would grow monotonically and mislead.
 */
export const ExternalThreadUsageSchema = Type.Object(
  {
    last: Type.Optional(ExternalUsageSchema),
    total: Type.Optional(ExternalUsageSchema),
  },
  { additionalProperties: false }
);

export type ExternalThreadUsage = Static<typeof ExternalThreadUsageSchema>;

/**
 * One metered window, as the vendor models it.
 *
 * `resetsAtMs` is milliseconds since epoch. Vendor reset times arrive as Unix
 * **seconds** and are converted exactly once at the shared/runtime boundary;
 * a field name ending in `AtMs` is the contract that conversion has already
 * happened.
 */
export const ExternalRateLimitWindowSchema = Type.Object(
  {
    /** Vendor label when one exists (e.g. primary/secondary limit name). Pass through, never translate. */
    label: Type.Optional(VendorText('title', { minLength: 1 })),
    usedPercent: Type.Number({ minimum: 0 }),
    windowDurationMins: Type.Optional(Type.Integer({ minimum: 0 })),
    resetsAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

export type ExternalRateLimitWindow = Static<typeof ExternalRateLimitWindowSchema>;

/** Pay-as-you-go credits snapshot. Absence means unknown, never zero. */
export const ExternalCreditsSchema = Type.Object(
  {
    hasCredits: Type.Optional(Type.Boolean()),
    unlimited: Type.Optional(Type.Boolean()),
    /** Vendor-reported balance string; not normalized to a number. */
    balance: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
  },
  { additionalProperties: false }
);

export type ExternalCredits = Static<typeof ExternalCreditsSchema>;

/** One redeemable rate-limit reset credit. Timestamps are epoch milliseconds. */
export const ExternalResetCreditSchema = Type.Object(
  {
    id: VendorText('vendorId', { minLength: 1 }),
    resetType: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    status: VendorText('accountLabel', { minLength: 1 }),
    grantedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    expiresAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    title: Type.Optional(VendorText('title')),
    description: Type.Optional(VendorText('detail')),
  },
  { additionalProperties: false }
);

export type ExternalResetCredit = Static<typeof ExternalResetCreditSchema>;

export const ExternalResetCreditsSchema = Type.Object(
  {
    availableCount: Type.Integer({ minimum: 0 }),
    /**
     * Detail rows when the vendor provided them. Omitted when only the count is
     * known; an empty array means details were fetched and none were available.
     */
    credits: Type.Optional(ReadonlyArraySchema(ExternalResetCreditSchema, { maxItems: 64 })),
  },
  { additionalProperties: false }
);

export type ExternalResetCredits = Static<typeof ExternalResetCreditsSchema>;

/** Spend-control limit. `None`/absent is unavailable, not "recovered". */
export const ExternalSpendControlSchema = Type.Object(
  {
    limit: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    used: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    remainingPercent: Type.Optional(Type.Number()),
    resetsAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Backend-reported; `null`/absent means unavailable, never a sparse recovery. */
    reached: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ExternalSpendControl = Static<typeof ExternalSpendControlSchema>;

/**
 * One metered limit bucket (primary + secondary windows, credits, plan).
 *
 * Derived field-by-field from Codex's `RateLimitSnapshot`. Labels and
 * `reachedType` pass through as the vendor sent them.
 */
export const ExternalRateLimitBucketSchema = Type.Object(
  {
    limitId: Type.Optional(VendorText('vendorId', { minLength: 1 })),
    limitName: Type.Optional(VendorText('title', { minLength: 1 })),
    primary: Type.Optional(ExternalRateLimitWindowSchema),
    secondary: Type.Optional(ExternalRateLimitWindowSchema),
    credits: Type.Optional(ExternalCreditsSchema),
    spendControl: Type.Optional(ExternalSpendControlSchema),
    planType: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    reachedType: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
  },
  { additionalProperties: false }
);

export type ExternalRateLimitBucket = Static<typeof ExternalRateLimitBucketSchema>;

export const ExternalRateLimitByIdSchema = Type.Object(
  {
    limitId: VendorText('vendorId', { minLength: 1 }),
    snapshot: ExternalRateLimitBucketSchema,
  },
  { additionalProperties: false }
);

export type ExternalRateLimitById = Static<typeof ExternalRateLimitByIdSchema>;

/**
 * Account-level plan quota, derived from Codex's `GetAccountRateLimitsResponse`.
 *
 * `windows` flattens the backward-compatible single-bucket view into an ordered
 * list the UI can render without inventing totals. `observedAtMs` drives
 * staleness: a stale snapshot renders as unknown, never as zero.
 */
export const ExternalAccountLimitsSchema = Type.Object(
  {
    targetId: ExternalAgentTargetIdSchema,
    windows: ReadonlyArraySchema(ExternalRateLimitWindowSchema, { maxItems: 16 }),
    byLimitId: Type.Optional(ReadonlyArraySchema(ExternalRateLimitByIdSchema, { maxItems: 32 })),
    credits: Type.Optional(ExternalCreditsSchema),
    spendControl: Type.Optional(ExternalSpendControlSchema),
    resetCredits: Type.Optional(ExternalResetCreditsSchema),
    planType: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    reachedType: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    /** When this snapshot was read or last successfully merged. Epoch ms. */
    observedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export type ExternalAccountLimits = Static<typeof ExternalAccountLimitsSchema>;

/** How long a cached account-limits snapshot stays "fresh" before rendering as stale. */
export const EXTERNAL_ACCOUNT_LIMITS_STALE_MS = 15 * 60_000;

/**
 * A failure, with the vendor's own structure preserved.
 *
 * Flattening this to a string is what makes "it failed" the only thing anyone
 * can say afterwards, so `vendorCode` and `retryable` survive the crossing.
 */
export const ExternalAgentErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: VendorText('errorMessage'),
    requestId: Type.Optional(VendorText('vendorId')),
    retryable: Type.Optional(Type.Boolean()),
    vendorCode: Type.Optional(VendorText('vendorId')),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ExternalAgentError = Static<typeof ExternalAgentErrorSchema>;

/**
 * The neutral event contract every adapter normalizes onto.
 *
 * Ordering and idempotency are *not* here: every event travels inside the
 * ordered envelope, so steering, usage and reconnect share one set of retry
 * rules instead of inventing three incompatible ones.
 */
export const ExternalAgentEventSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('session_started'),
      /** The vendor's own session handle. Server-owned; no client request writes it. */
      sessionId: VendorText('vendorId', { minLength: 1 }),
      resumed: Type.Boolean(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('text_delta'), text: Type.String() },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('reasoning_delta'), text: Type.String() },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('activity_started'),
      callId: VendorText('vendorId', { minLength: 1 }),
      activity: ExternalActivityViewSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('activity_updated'),
      callId: VendorText('vendorId', { minLength: 1 }),
      update: ExternalActivityUpdateSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('activity_completed'),
      callId: VendorText('vendorId', { minLength: 1 }),
      result: ExternalActivityResultSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('approval_requested'), request: ExternalApprovalRequestSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('approval_resolved'),
      requestId: VendorText('vendorId', { minLength: 1 }),
      decision: ExternalApprovalDecisionSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('usage'), usage: ExternalUsageSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('thread_usage'), usage: ExternalThreadUsageSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('account_limits'), limits: ExternalAccountLimitsSchema },
    { additionalProperties: false }
  ),
  Type.Object({ type: Type.Literal('completed') }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('error'), error: ExternalAgentErrorSchema },
    { additionalProperties: false }
  ),
]);

export type ExternalAgentEvent = Static<typeof ExternalAgentEventSchema>;

/** Whether a probe could see a sign-in, and whether it is allowed to be sure. */
export const ExternalAgentAuthStateSchema = Type.Union([
  Type.Literal('signed-in'),
  Type.Literal('signed-out'),
  Type.Literal('unknown'),
]);

export type ExternalAgentAuthState = Static<typeof ExternalAgentAuthStateSchema>;

/** Why a target cannot be selected. */
export const ExternalAgentUnavailableReasonSchema = Type.Union([
  Type.Literal('not-installed'),
  Type.Literal('signed-out'),
  /** The paired runtime has no adapter for this target. */
  Type.Literal('runtime-unsupported'),
  /** The machine's owner refused consent. */
  Type.Literal('runtime-denied'),
  Type.Literal('environment-unreachable'),
  /** The transport has not attested an isolated OS identity. */
  Type.Literal('isolation-unproven'),
  /**
   * The installed CLI does not serve the contract this runtime was built
   * against, and an upgrade is what fixes it.
   *
   * Reported by an adapter, never inferred here, and never from a version
   * comparison alone. A number below the pin is a *warning*; what makes a
   * target unavailable is a probe finding the surface missing — an ACP
   * handshake that does not answer, a flag the turn's argv names that the
   * binary does not have. The distinction matters because vendors ship
   * constantly: gating on the number would grey out working installs every
   * time a pin went stale, which is the failure the drift job exists to make
   * unnecessary.
   *
   * `requiredVersion` on the descriptor names the build that would clear it, so
   * the row says what to upgrade to rather than only that something is wrong.
   */
  Type.Literal('version-unsupported'),
  /**
   * The user has not acknowledged this vendor's third-party disclosure.
   *
   * Advisory here, so the selector knows to prompt. The authoritative refusal
   * happens at turn start, because this descriptor is cached and an
   * acknowledgement can be revoked while a stale one is still being rendered.
   */
  Type.Literal('disclosure-required'),
]);

export type ExternalAgentUnavailableReason = Static<typeof ExternalAgentUnavailableReasonSchema>;

export const EXTERNAL_AGENT_UNAVAILABLE_REASONS: readonly ExternalAgentUnavailableReason[] =
  ExternalAgentUnavailableReasonSchema.anyOf.map((literal) => literal.const);

/**
 * Who the vendor thinks is signed in, as a label the owner is looking at.
 *
 * Personal data, so it is minimal by construction: Claude's status call returns
 * `email`, `orgId` and `orgName`, and none of those leave the runtime. This is
 * returned only to the owning user, is never persisted into chat history, and
 * is redacted in diagnostics and logs.
 */
export const ExternalAgentAccountSchema = Type.Object(
  {
    label: VendorText('accountLabel', { minLength: 1 }),
    planType: Type.Optional(VendorText('accountLabel')),
    /** Opaque, non-reversible digest for invalidating continuation after an account change. */
    fingerprint: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false }
);

export type ExternalAgentAccount = Static<typeof ExternalAgentAccountSchema>;

/**
 * How a descriptor was arrived at, for diagnostics rather than for the selector.
 *
 * Discovery is not free for every vendor. Codex answers from three calls on one
 * connection; Cursor exposes its model catalog only on a live session, so a full
 * answer costs a process launch, a protocol handshake and a session. Adapters
 * that pay that cost cache the result, and a cache nobody can see is a cache
 * nobody can debug — "why is this agent still showing the old version" has no
 * answer without knowing whether the last answer was probed or remembered.
 *
 * Optional because it is a claim only an adapter that actually caches can make.
 * Nothing here changes what the selector renders.
 */
export const ExternalAgentDiscoveryReportSchema = Type.Object(
  {
    /** `live` means a probe ran for this answer; `cache` means it was remembered. */
    source: Type.Union([Type.Literal('live'), Type.Literal('cache')]),
    /** When the underlying probe ran — not when this response was built. */
    probedAtMs: Type.Integer({ minimum: 0 }),
    /** Handshake attempts the probe took. Above one means something was retried. */
    attempts: Type.Integer({ minimum: 1, maximum: 16 }),
    /** The adapter's own code for a probe that failed. Never vendor text. */
    failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false }
);

export type ExternalAgentDiscoveryReport = Static<typeof ExternalAgentDiscoveryReportSchema>;

/**
 * One external agent, in one environment, as the selector needs it.
 *
 * `executablePath` is deliberately absent. A path the client can never
 * legitimately render has no reason to cross the wire.
 */
export const ExternalAgentDescriptorSchema = Type.Object(
  {
    targetId: ExternalAgentTargetIdSchema,
    environmentId: Type.String({ minLength: 1 }),
    installed: Type.Boolean(),
    /**
     * Vendor-supplied, so bounded on `VendorText` terms: the runtime cuts both
     * fields to `accountLabel`'s 128 **code points**, and a plain
     * `maxLength: 128` counts UTF-16 units, which would reject a correctly
     * bounded string that happens to carry an astral character.
     */
    version: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    /**
     * The oldest build that would clear a `version-unsupported` verdict.
     *
     * MangoStudio's own pin rather than vendor text, so it is bounded as a
     * plain string: it is read from the adapter's `pinned.ts`, never from
     * anything the CLI printed. Present only alongside that reason, because a
     * required version on a target that is already working would invite the
     * reading that anything older is refused — which is exactly what this
     * runtime does not do.
     */
    requiredVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    authState: ExternalAgentAuthStateSchema,
    /** The literal command that signs the user in, e.g. `codex login`. Shown with a copy button. */
    loginCommand: Type.Optional(VendorText('accountLabel', { minLength: 1 })),
    capabilities: ExternalAgentCapabilitiesSchema,
    supportedConfigurations: ExternalSupportedConfigurationListSchema,
    /** Rich model catalog when the adapter can enumerate one; absent on older discovery paths. */
    models: Type.Optional(ExternalAgentModelCatalogSchema),
    account: Type.Optional(ExternalAgentAccountSchema),
    unavailableReason: Type.Optional(ExternalAgentUnavailableReasonSchema),
    discovery: Type.Optional(ExternalAgentDiscoveryReportSchema),
  },
  { additionalProperties: false }
);

export type ExternalAgentDescriptor = Static<typeof ExternalAgentDescriptorSchema>;

export const ExternalAgentDescriptorListResponseSchema = Type.Object(
  {
    environmentId: Type.String({ minLength: 1 }),
    agents: ReadonlyArraySchema(ExternalAgentDescriptorSchema, {
      maxItems: EXTERNAL_AGENT_TARGET_IDS.length,
    }),
  },
  { additionalProperties: false }
);

export type ExternalAgentDescriptorListResponse = Static<
  typeof ExternalAgentDescriptorListResponseSchema
>;

/** Runtime-owned discovery omits the hub's environment id, which the hub projects afterwards. */
export const ExternalAgentRuntimeDescriptorSchema = Type.Omit(ExternalAgentDescriptorSchema, [
  'environmentId',
]);

export type ExternalAgentRuntimeDescriptor = Static<typeof ExternalAgentRuntimeDescriptorSchema>;

const ExternalAgentOpaqueIdSchema = VendorText('vendorId', { minLength: 1 });
const ExternalAgentTimeoutSchema = Type.Integer({ minimum: 1, maximum: 300_000 });

export const ExternalAgentDiscoverParamsSchema = Type.Object(
  {
    targetIds: ReadonlyArraySchema(ExternalAgentTargetIdSchema, {
      minItems: 1,
      maxItems: EXTERNAL_AGENT_TARGET_IDS.length,
      uniqueItems: true,
    }),
    timeoutMs: ExternalAgentTimeoutSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentDiscoverParams = Static<typeof ExternalAgentDiscoverParamsSchema>;

export const ExternalAgentDiscoverResultSchema = Type.Object(
  {
    descriptors: ReadonlyArraySchema(ExternalAgentRuntimeDescriptorSchema, {
      maxItems: EXTERNAL_AGENT_TARGET_IDS.length,
    }),
  },
  { additionalProperties: false }
);
export type ExternalAgentDiscoverResult = Static<typeof ExternalAgentDiscoverResultSchema>;

export const ExternalAgentResumeModeSchema = Type.Union([
  Type.Literal('strict'),
  Type.Literal('fallback'),
]);
export type ExternalAgentResumeMode = Static<typeof ExternalAgentResumeModeSchema>;

export const ExternalAgentOpenParamsSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    targetId: ExternalAgentTargetIdSchema,
    workspacePath: Type.String({ minLength: 1, maxLength: 4_096 }),
    configuration: ExternalAgentConfigurationSchema,
    resumeRef: Type.Optional(ExternalAgentOpaqueIdSchema),
    resumeMode: ExternalAgentResumeModeSchema,
    timeoutMs: ExternalAgentTimeoutSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentOpenParams = Static<typeof ExternalAgentOpenParamsSchema>;

export const ExternalAgentOpenResultSchema = Type.Object(
  {
    nativeSessionId: ExternalAgentOpaqueIdSchema,
    resumed: Type.Boolean(),
    fallbackReason: Type.Optional(VendorText('errorMessage')),
    effectiveConfiguration: ExternalAgentConfigurationSchema,
    capabilities: ExternalAgentCapabilitiesSchema,
    /** Baseline account quota when the adapter read one on open. */
    accountLimits: Type.Optional(ExternalAccountLimitsSchema),
  },
  { additionalProperties: false }
);
export type ExternalAgentOpenResult = Static<typeof ExternalAgentOpenResultSchema>;

export const ExternalAgentTurnParamsSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    clientMessageId: ExternalAgentOpaqueIdSchema,
    input: Type.String({ maxLength: 1024 * 1024 }),
    configuration: ExternalAgentConfigurationSchema,
    attachments: Type.Optional(
      ReadonlyArraySchema(ExternalAgentAttachmentSchema, { maxItems: 4, uniqueItems: true })
    ),
  },
  { additionalProperties: false }
);
export type ExternalAgentTurnParams = Static<typeof ExternalAgentTurnParamsSchema>;

export const ExternalAgentTurnResultSchema = Type.Object(
  { nativeTurnId: ExternalAgentOpaqueIdSchema },
  { additionalProperties: false }
);
export type ExternalAgentTurnResult = Static<typeof ExternalAgentTurnResultSchema>;

export const ExternalAgentRespondParamsSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    nativeTurnId: ExternalAgentOpaqueIdSchema,
    requestId: ExternalAgentOpaqueIdSchema,
    optionId: ExternalAgentOpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentRespondParams = Static<typeof ExternalAgentRespondParamsSchema>;

export const ExternalAgentCancelParamsSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    nativeTurnId: Type.Optional(ExternalAgentOpaqueIdSchema),
  },
  { additionalProperties: false }
);
export type ExternalAgentCancelParams = Static<typeof ExternalAgentCancelParamsSchema>;

export const ExternalAgentCloseParamsSchema = Type.Object(
  { sessionId: ExternalAgentOpaqueIdSchema },
  { additionalProperties: false }
);
export type ExternalAgentCloseParams = Static<typeof ExternalAgentCloseParamsSchema>;

/**
 * Manual account-limits refresh. Prefer a live session when one exists; otherwise
 * the runtime opens a short-lived connection for `account/rateLimits/read`.
 */
export const ExternalAgentRefreshAccountUsageParamsSchema = Type.Object(
  {
    targetId: ExternalAgentTargetIdSchema,
    /** When set, refresh against this live session rather than opening a probe. */
    sessionId: Type.Optional(ExternalAgentOpaqueIdSchema),
    timeoutMs: ExternalAgentTimeoutSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentRefreshAccountUsageParams = Static<
  typeof ExternalAgentRefreshAccountUsageParamsSchema
>;

export const ExternalAgentRefreshAccountUsageResultSchema = Type.Object(
  {
    /**
     * Absent when the adapter has no account-usage surface, or when a baseline
     * could not be read (signed out, timed out). Absence is unknown, never zero.
     */
    limits: Type.Optional(ExternalAccountLimitsSchema),
  },
  { additionalProperties: false }
);
export type ExternalAgentRefreshAccountUsageResult = Static<
  typeof ExternalAgentRefreshAccountUsageResultSchema
>;

export const ExternalAgentAckResultSchema = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false }
);
export type ExternalAgentAckResult = Static<typeof ExternalAgentAckResultSchema>;

/**
 * One conversation a vendor already owns, as a picker row.
 *
 * This is a *pointer*, not an import. Nothing here carries transcript content:
 * adopting a session records which vendor conversation a chat continues, and
 * the vendor keeps the history it wrote.
 *
 * `updatedAtMs` is milliseconds since epoch, normalized exactly once at the
 * runtime boundary — Codex reports Unix **seconds**, Cursor an **ISO-8601**
 * string, and no consumer past the adapter sees either. The `AtMs` suffix is
 * the contract that the conversion already happened.
 *
 * Both text fields are vendor-supplied and therefore bounded and inert:
 * `title` is Codex's nullable thread name, `preview` its "usually the first
 * user message". Cursor has **neither** — its listing is `sessionId`, `cwd` and
 * `updatedAt` and nothing else — so a row with no title is a complete answer
 * rather than a missing one, and nothing synthesizes text to fill the gap.
 */
export const ExternalNativeSessionSchema = Type.Object(
  {
    targetId: ExternalAgentTargetIdSchema,
    /** Codex: `Thread.id`, never `Thread.sessionId`. Cursor: `sessionId`. */
    nativeSessionId: ExternalAgentOpaqueIdSchema,
    title: Type.Optional(VendorText('sessionTitle', { minLength: 1 })),
    preview: Type.Optional(VendorText('sessionTitle', { minLength: 1 })),
    /** The vendor's own working directory for the session, when it reports one. */
    workspacePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type ExternalNativeSession = Static<typeof ExternalNativeSessionSchema>;

/**
 * How many sessions one page may carry.
 *
 * A ceiling rather than a preference: vendor histories are unbounded, and the
 * picker pages through them. Stated here so the runtime, the hub and the schema
 * cannot disagree about what "a page" is.
 */
export const EXTERNAL_NATIVE_SESSION_PAGE_LIMIT = 50;

export const ExternalAgentListSessionsParamsSchema = Type.Object(
  {
    targetId: ExternalAgentTargetIdSchema,
    /**
     * Filter to one workspace, exactly as the vendor spells it.
     *
     * Also the directory the listing connection is authorized against, which is
     * why it is a canonical path and not a pattern: a listing is a read of
     * another machine's conversation history, and it happens inside the
     * runtime-owner's workspace policy like everything else.
     */
    workspacePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    cursor: Type.Optional(ExternalAgentOpaqueIdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EXTERNAL_NATIVE_SESSION_PAGE_LIMIT })),
    /** When set, answer from this live session's connection instead of a probe. */
    sessionId: Type.Optional(ExternalAgentOpaqueIdSchema),
    timeoutMs: ExternalAgentTimeoutSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentListSessionsParams = Static<typeof ExternalAgentListSessionsParamsSchema>;

export const ExternalAgentListSessionsResultSchema = Type.Object(
  {
    sessions: ReadonlyArraySchema(ExternalNativeSessionSchema, {
      maxItems: EXTERNAL_NATIVE_SESSION_PAGE_LIMIT,
    }),
    /** Absent when the vendor has no further pages. */
    nextCursor: Type.Optional(ExternalAgentOpaqueIdSchema),
  },
  { additionalProperties: false }
);
export type ExternalAgentListSessionsResult = Static<typeof ExternalAgentListSessionsResultSchema>;

/** The hub's own answer: the runtime's page, plus which machine it describes. */
export const ExternalNativeSessionListResponseSchema = Type.Object(
  {
    environmentId: Type.String({ minLength: 1 }),
    sessions: ReadonlyArraySchema(ExternalNativeSessionSchema, {
      maxItems: EXTERNAL_NATIVE_SESSION_PAGE_LIMIT,
    }),
    nextCursor: Type.Optional(ExternalAgentOpaqueIdSchema),
  },
  { additionalProperties: false }
);
export type ExternalNativeSessionListResponse = Static<
  typeof ExternalNativeSessionListResponseSchema
>;

/**
 * What adoption is asked for: a machine, and the row the picker rendered.
 *
 * The row is an *expectation*, not an input. The server re-reads the session
 * from the vendor before it creates anything and refuses when the answer
 * differs, so nothing it stores comes from here — the workspace a chat ends up
 * with is the one the vendor confirmed. What echoing the row buys is the
 * refusal: without it, adoption would attach to whatever that id points at now,
 * which may be a conversation the user never saw.
 */
export const ExternalSessionAdoptionRequestSchema = Type.Object(
  {
    environmentId: Type.String({ minLength: 1, maxLength: 256 }),
    session: ExternalNativeSessionSchema,
  },
  { additionalProperties: false }
);
export type ExternalSessionAdoptionRequest = Static<typeof ExternalSessionAdoptionRequestSchema>;

/**
 * How an external turn ended. A closed set, deliberately.
 *
 * Every member is a state the hub can actually reach, and a turn that ends for
 * a reason outside this union is a defect rather than a new case: the whole
 * point of enumerating them is that recovery, the transcript and the UI decide
 * from the same vocabulary instead of each inventing its own.
 *
 * `completed` is the vendor saying it is done. Everything else is MangoStudio
 * saying why it stopped believing the vendor would.
 */
export const ExternalTurnTerminalReasonSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('cancelled-by-user'),
  /** The vendor reported a failure; the structured error survives on the turn. */
  Type.Literal('vendor-error'),
  Type.Literal('runtime-disconnected'),
  /** Found `isGenerating` with no live registration when the hub came back up. */
  Type.Literal('hub-restarted'),
  /** The ordered stream skipped a sequence, so the transcript is knowably partial. */
  Type.Literal('sequence-gap'),
  /** The turn passed its persisted byte or event budget. */
  Type.Literal('limit-exceeded'),
  /** The machine's owner withdrew permission to run external agents. */
  Type.Literal('consent-revoked'),
  /** The runtime no longer has the session this turn was addressed to. */
  Type.Literal('session-lost'),
]);

export type ExternalTurnTerminalReason = Static<typeof ExternalTurnTerminalReasonSchema>;

export const EXTERNAL_TURN_TERMINAL_REASONS: readonly ExternalTurnTerminalReason[] =
  ExternalTurnTerminalReasonSchema.anyOf.map((literal) => literal.const);

/**
 * Why a steer was refused. A closed set, like {@link ExternalTurnTerminalReasonSchema}.
 *
 * Steering is Codex-only and turn-state-specific rather than only adapter-
 * specific, which is why this is not a subset of the unavailable reasons:
 * `turn-not-steerable` exists because a review or compaction turn refuses it
 * even when the adapter and the session both support steering in general.
 */
export const ExternalSteerRejectionReasonSchema = Type.Union([
  /** The turn ended before the steer reached it — a race the user can hit legitimately. */
  Type.Literal('turn-already-completed'),
  /** The adapter has no `steer` member, or the session's capabilities say so. */
  Type.Literal('not-supported'),
  /** The runtime no longer has the session this steer was addressed to. */
  Type.Literal('session-lost'),
  /** The vendor refused steering for this specific turn, e.g. a review or compaction turn. */
  Type.Literal('turn-not-steerable'),
  /**
   * The same `clientMessageId` was already attempted with different text. A
   * lost acknowledgement legitimately retries with the same id *and* the same
   * text; this is what a client hits if it reuses the id after editing the
   * composer instead — answering from the earlier attempt's cached outcome
   * would silently drop the edit.
   */
  Type.Literal('id-reused'),
]);

export type ExternalSteerRejectionReason = Static<typeof ExternalSteerRejectionReasonSchema>;

export const EXTERNAL_STEER_REJECTION_REASONS: readonly ExternalSteerRejectionReason[] =
  ExternalSteerRejectionReasonSchema.anyOf.map((literal) => literal.const);

/**
 * Codex only. `nativeTurnId` is the hub's own turn handle — the same value
 * `ExternalAgentTurnResult.nativeTurnId` returned — not the vendor's internal
 * turn id, which stays inside the adapter.
 */
export const ExternalAgentSteerParamsSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    nativeTurnId: ExternalAgentOpaqueIdSchema,
    clientMessageId: ExternalAgentOpaqueIdSchema,
    input: Type.String({ maxLength: 1024 * 1024 }),
  },
  { additionalProperties: false }
);
export type ExternalAgentSteerParams = Static<typeof ExternalAgentSteerParamsSchema>;

export const ExternalAgentSteerResultSchema = Type.Union([
  Type.Object({ accepted: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object(
    { accepted: Type.Literal(false), reasonCode: ExternalSteerRejectionReasonSchema },
    { additionalProperties: false }
  ),
]);
export type ExternalAgentSteerResult = Static<typeof ExternalAgentSteerResultSchema>;

/**
 * What a native review is pointed at.
 *
 * A discriminated union with one member, deliberately. Codex's own
 * `ReviewTarget` also carries `baseBranch`, `commit` and `custom`, and modelling
 * this as a string enum would make adding them a breaking reshape rather than
 * one more object in the union. Only `uncommittedChanges` ships: it is the one
 * target the action's own name describes, and the rest are eight combinations of
 * copy, tests and explanation before anyone has used the first one.
 *
 * `uncommittedChanges` is staged, unstaged **and** untracked work, as the vendor
 * defines it — MangoStudio does not narrow it.
 */
export const ExternalReviewTargetSchema = Type.Union([
  Type.Object({ type: Type.Literal('uncommittedChanges') }, { additionalProperties: false }),
]);

export type ExternalReviewTarget = Static<typeof ExternalReviewTargetSchema>;

/**
 * Start a vendor-native review on an open session.
 *
 * `clientMessageId` is the turn's idempotency key exactly as it is for an
 * ordinary turn: a review is a turn that happens to be a review, and it is
 * deduplicated, ordered, persisted and cancelled by the same machinery.
 *
 * Delivery is absent on purpose. Only inline ships, so there is nothing to
 * choose — and an adapter that let a caller ask for a detached review would be
 * promising a second thread the hub is not tracking.
 *
 * Configuration is absent on purpose too. A review runs under the permissions
 * the session already has; it does not carry a new sandbox, approval policy or
 * model the way `turn/start` does. Reopening or reconfiguring mid-review would
 * be a way around a choice the user already made for this thread.
 */
export const ExternalAgentStartReviewParamsSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    clientMessageId: ExternalAgentOpaqueIdSchema,
    target: ExternalReviewTargetSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentStartReviewParams = Static<typeof ExternalAgentStartReviewParamsSchema>;

/**
 * The vendor's answer, both halves of it.
 *
 * `ReviewStartResponse` returns a turn **and** the thread the review runs on,
 * and a detached review runs on a different thread than the one that asked for
 * it. Carrying `reviewThreadId` back rather than dropping it is what lets the
 * hub assert that an inline review stayed on the tracked thread instead of
 * assuming it: if a future Codex changes that, the assertion fails loudly rather
 * than the events arriving on a thread nobody is listening to.
 */
export const ExternalAgentStartReviewResultSchema = Type.Object(
  {
    nativeTurnId: ExternalAgentOpaqueIdSchema,
    /** Inline delivery: the session's own thread. Asserted, never assumed. */
    reviewThreadId: ExternalAgentOpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentStartReviewResult = Static<typeof ExternalAgentStartReviewResultSchema>;

/** Semantic event ordering is per session and starts at one, independently of transport seq. */
export const ExternalAgentEventEnvelopeSchema = Type.Object(
  {
    sessionId: ExternalAgentOpaqueIdSchema,
    nativeTurnId: Type.Optional(ExternalAgentOpaqueIdSchema),
    sequence: Type.Integer({ minimum: 1 }),
    emittedAtMs: Type.Integer({ minimum: 0 }),
    /**
     * Reserved for the hub's turn controller, which deduplicates and retries
     * against it. Declared before anything produces it on purpose: this
     * envelope is closed, and a consumer built before the key existed fails
     * the whole check and drops the event rather than ignoring the key —
     * silently, since the topic listener has nowhere to report to. Adding it
     * later would strand every pair of peers the protocol version calls
     * compatible.
     */
    idempotencyKey: Type.Optional(ExternalAgentOpaqueIdSchema),
    event: ExternalAgentEventSchema,
  },
  { additionalProperties: false }
);
export type ExternalAgentEventEnvelope = Static<typeof ExternalAgentEventEnvelopeSchema>;
