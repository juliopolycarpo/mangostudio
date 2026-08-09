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

import { type Static, Type } from '@sinclair/typebox';
import { ReadonlyArraySchema } from '../schema-helpers';
import { type ExternalTextLimit, schemaMaxLengthFor } from './vendor-text';

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
 * Every flag false is the only honest answer with no adapter in the loop, and
 * it is what the discovery surface returns while the release gate is closed.
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
    options: ReadonlyArraySchema(ExternalApprovalOptionSchema, { minItems: 1, maxItems: 16 }),
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

/**
 * Why a target cannot be selected.
 *
 * `not-yet-available` is the availability gate: hosting a turn arrives in
 * stages, and until the last of them a selectable external runner could block on
 * an approval nobody can answer. That member — and the constant that sets it —
 * is deleted once a turn can complete.
 */
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
  Type.Literal('not-yet-available'),
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
  },
  { additionalProperties: false }
);

export type ExternalAgentAccount = Static<typeof ExternalAgentAccountSchema>;

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
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    authState: ExternalAgentAuthStateSchema,
    /** The literal command that signs the user in, e.g. `codex login`. Shown with a copy button. */
    loginCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    capabilities: ExternalAgentCapabilitiesSchema,
    supportedConfigurations: ExternalSupportedConfigurationListSchema,
    account: Type.Optional(ExternalAgentAccountSchema),
    unavailableReason: Type.Optional(ExternalAgentUnavailableReasonSchema),
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
