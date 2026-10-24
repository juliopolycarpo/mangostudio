import Type, { type Static } from 'typebox';
import { schemaMaxLengthFor } from './vendor-text';

/**
 * One vendor-chosen identifier a client may send or a chat may store.
 *
 * A model id and an effort id are both this: opaque strings the vendor minted
 * and will be handed back, never a MangoStudio enum. Exported so the wire shape
 * (`ExternalTurnRequestSchema`), the persisted shape
 * (`ChatRunnerModelSelectionSchema`) and the descriptor's catalog all bound the
 * same value the same way — three spellings of one bound is how a value that
 * fits in a request ends up rejected on its way to the row that must hold it.
 *
 * Bounding is all this does. It is deliberately **not** a claim that the value
 * names anything: no catalog is reachable from here, so whether a vendor still
 * offers this model is decided at send time, and whether it is safe to put on a
 * command line is decided by the adapter that builds one.
 */
export const ExternalVendorIdSchema = Type.String({
  minLength: 1,
  maxLength: schemaMaxLengthFor('vendorId'),
});

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
 *
 * @example
 * isExternalAgentTargetId('codex'); // true
 */
export function isExternalAgentTargetId(value: string): value is ExternalAgentTargetId {
  return EXTERNAL_AGENT_TARGET_IDS.some((targetId) => targetId === value);
}

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
  /**
   * The agent is installed, signed in and answering — and supports none of the
   * permission combinations MangoStudio offers.
   *
   * Inferred by the hub from the matrix the adapter returned, never reported by
   * an adapter: each one already states, per cell, why that cell is refused,
   * and this is what "every cell" adds up to. Without it such a target looks
   * simply selectable until a send is refused, which is the shape #813
   * describes.
   */
  Type.Literal('installed-but-unusable'),
]);

export type ExternalAgentUnavailableReason = Static<typeof ExternalAgentUnavailableReasonSchema>;

export const EXTERNAL_AGENT_UNAVAILABLE_REASONS: readonly ExternalAgentUnavailableReason[] =
  ExternalAgentUnavailableReasonSchema.anyOf.map((literal) => literal.const);

/**
 * What MangoStudio can offer to fix an agent that cannot run.
 *
 * The shape lives here with the reason it answers; which reason maps to which
 * remedy is policy and lives in `remedies.ts`. A greyed row that says *why* is
 * already better than one that says nothing and is still a diagnosis — the
 * person reading it wants the next step, named as something the interface can
 * render as a control.
 */
export const ExternalAgentRemedyKindSchema = Type.Union([
  /** The CLI is not on this machine; an install recipe exists for it. */
  Type.Literal('install'),
  /** It is installed but too old for the contract this runtime drives. */
  Type.Literal('update'),
  /** It is installed and current; the vendor account is not signed in. */
  Type.Literal('sign-in'),
  /** Nothing the user can do from here — the machine's owner decides. */
  Type.Literal('contact-admin'),
  /** MangoStudio is asking for something, and the dialog is already reachable. */
  Type.Literal('accept-disclosure'),
  /** Knowably unfixable from the interface, so no control is offered. */
  Type.Literal('none'),
]);

export type ExternalAgentRemedyKind = Static<typeof ExternalAgentRemedyKindSchema>;

export const ExternalAgentRemedySchema = Type.Object(
  {
    kind: ExternalAgentRemedyKindSchema,
    /**
     * A command to run, when the remedy has one and MangoStudio cannot run it.
     *
     * The vendor's own sign-in command is the case this exists for. An install
     * or update is *not*: those resolve to a recipe the environments surface
     * already owns, and a second copy of the command string here would be one
     * more thing to keep in step with it.
     */
    command: Type.Optional(ExternalVendorIdSchema),
  },
  { additionalProperties: false }
);

export type ExternalAgentRemedy = Static<typeof ExternalAgentRemedySchema>;
