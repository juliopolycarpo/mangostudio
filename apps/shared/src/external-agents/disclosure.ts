/**
 * The one-time disclosure shown before a vendor first runs a turn.
 *
 * Handing a conversation to a third-party CLI is not an implementation detail
 * the way choosing a model is: another company's software runs on the user's
 * machine, under its own terms, billed to its own account, and — depending on
 * the permission level — edits files and runs commands without asking. That is a
 * Terms-of-Service obligation, and a boolean cannot carry it.
 *
 * So an acknowledgement records **which vendor, which disclosure version, and
 * when**, plus a fingerprint of what the adapter said it could do at the time.
 * Either changing re-prompts:
 *
 * - the **version** covers MangoStudio rewriting the text, and
 * - the **fingerprint** covers the vendor quietly gaining a capability the user
 *   was never told about — a CLI that could not run commands when the user
 *   agreed, and can now, is a different disclosure.
 *
 * Browser-safe: no Node builtins.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';
import type { ExternalAgentCapabilities, ExternalAgentTargetId } from './schemas';
import { ExternalAgentTargetIdSchema } from './schemas';

/**
 * Bump when the disclosure text changes materially.
 *
 * A wording fix does not need it; adding or removing a claim about where data
 * goes, who is billed, or what the agent may do without asking does.
 */
export const EXTERNAL_DISCLOSURE_VERSION = 1;

/**
 * The fingerprint's upper bound, shared so the schema and the settings
 * normalizer cannot drift apart.
 *
 * The current material list produces about 104 characters, and a normalizer
 * that admitted a longer one would hand `AppSettingsPutBodySchema` a value it
 * rejects on the next save.
 */
export const EXTERNAL_DISCLOSURE_FINGERPRINT_MAX_LENGTH = 256;

export const ExternalAgentDisclosureSchema = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  acceptedAt: Type.Integer({ minimum: 0 }),
  /** What the adapter declared when this was accepted. */
  capabilitiesFingerprint: Type.String({
    minLength: 1,
    maxLength: EXTERNAL_DISCLOSURE_FINGERPRINT_MAX_LENGTH,
  }),
});

export type ExternalAgentDisclosure = Static<typeof ExternalAgentDisclosureSchema>;

/**
 * Bump when the workspace-trust text changes materially.
 *
 * Independent of {@link EXTERNAL_DISCLOSURE_VERSION} because the two say
 * different things: the vendor disclosure is about handing a conversation to a
 * third party, this one is about that third party loading configuration out of
 * a specific directory.
 */
export const EXTERNAL_WORKSPACE_TRUST_VERSION = 1;

/**
 * Which vendors need a workspace trusted before they may run in it.
 *
 * Cursor only, for now, and the narrowness is the point. Opening an ACP session
 * against a directory makes `cursor-agent` load that directory's Cursor rules,
 * project configuration and MCP server definitions — a decision about
 * **executing third-party configuration**, which is not the same decision as
 * choosing where files live. The previous revision of this plan called `--trust`
 * "effectively path selection"; it is not.
 *
 * The other two adapters read project files too, and extending this list is how
 * they would opt in. They are absent because nobody has yet written down what
 * each of them loads, and a disclosure that cannot name what it covers is a
 * dialog people learn to dismiss.
 */
export const EXTERNAL_WORKSPACE_TRUST_TARGETS: readonly ExternalAgentTargetId[] = ['cursor'];

/**
 * How many trusted workspaces one user keeps.
 *
 * Settings are one row and one PUT, so this is a real bound rather than a
 * theoretical one. The oldest entry is dropped when the list is full, which
 * re-prompts for a workspace nobody has touched in a long time — the safe
 * direction to fail in.
 */
export const EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES = 200;

/**
 * One `(target, environment, canonical workspace)` the user has agreed to.
 *
 * The path is the **canonical** one, as the machine that runs the vendor spells
 * it. A hub-side or client-side spelling would let the same directory be
 * trusted under two names, and the check that matters happens where the vendor
 * is actually started.
 */
export const ExternalWorkspaceTrustSchema = Type.Object(
  {
    targetId: ExternalAgentTargetIdSchema,
    environmentId: Type.String({ minLength: 1, maxLength: 128 }),
    workspacePath: Type.String({ minLength: 1, maxLength: 4_096 }),
    version: Type.Integer({ minimum: 1 }),
    acceptedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export type ExternalWorkspaceTrust = Static<typeof ExternalWorkspaceTrustSchema>;

/**
 * One acknowledgement per vendor, plus the workspaces they may load
 * configuration from.
 *
 * Absent means the user has not been asked — which is why every disclosure key
 * is optional and why the trust list starts empty. A missing entry can never
 * read as consent.
 */
export const ExternalAgentSettingsSchema = Type.Object({
  disclosures: Type.Partial(
    Type.Record(ExternalAgentTargetIdSchema, ExternalAgentDisclosureSchema, {
      additionalProperties: false,
    })
  ),
  workspaceTrust: ReadonlyArraySchema(ExternalWorkspaceTrustSchema, {
    maxItems: EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES,
  }),
});

export type ExternalAgentSettings = Static<typeof ExternalAgentSettingsSchema>;

export const DEFAULT_EXTERNAL_AGENT_SETTINGS: ExternalAgentSettings = {
  disclosures: {},
  workspaceTrust: [],
};

export interface ExternalWorkspaceTrustKey {
  readonly targetId: ExternalAgentTargetId;
  readonly environmentId: string;
  readonly workspacePath: string;
}

function matchesKey(entry: ExternalWorkspaceTrust, key: ExternalWorkspaceTrustKey): boolean {
  return (
    entry.targetId === key.targetId &&
    entry.environmentId === key.environmentId &&
    entry.workspacePath === key.workspacePath
  );
}

/**
 * True when this vendor still needs the workspace disclosure before it may run
 * here.
 *
 * A target that loads nothing third-party never needs it, so the list is
 * consulted first — asking about a workspace for a vendor that does not read it
 * would be a dialog with no claim behind it.
 */
export function needsWorkspaceTrust(
  entries: readonly ExternalWorkspaceTrust[],
  key: ExternalWorkspaceTrustKey
): boolean {
  if (!EXTERNAL_WORKSPACE_TRUST_TARGETS.includes(key.targetId)) return false;
  const accepted = entries.find((entry) => matchesKey(entry, key));
  return !accepted || accepted.version !== EXTERNAL_WORKSPACE_TRUST_VERSION;
}

/**
 * The list with this workspace trusted, replacing any earlier entry for it.
 *
 * Pure, and returns a new array, so the settings mutation stays a single write
 * of a value the caller can validate before sending.
 */
export function withWorkspaceTrust(
  entries: readonly ExternalWorkspaceTrust[],
  key: ExternalWorkspaceTrustKey,
  acceptedAt: number
): ExternalWorkspaceTrust[] {
  const kept = entries.filter((entry) => !matchesKey(entry, key));
  const next = [...kept, { ...key, version: EXTERNAL_WORKSPACE_TRUST_VERSION, acceptedAt }];
  // Oldest first, so the slice keeps the most recently agreed ones.
  return next.length <= EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES
    ? next
    : next.slice(next.length - EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES);
}

/**
 * A stable, order-independent summary of what a vendor said it can do.
 *
 * Only the flags a user would recognize as a claim about their machine or their
 * data are included: whether it acts on its own, whether it can be interrupted,
 * whether it reports what it spent. `resume` or `sessionListing` changing is not
 * something anyone agreed or objected to, and re-prompting on it would train
 * people to dismiss the dialog.
 */
export function externalCapabilitiesFingerprint(capabilities: ExternalAgentCapabilities): string {
  const material: readonly (keyof ExternalAgentCapabilities)[] = [
    'interactiveApprovals',
    'images',
    'usageReporting',
    'cancellation',
    'steering',
    'nativeReview',
    'accountUsage',
  ];
  return material.map((flag) => `${flag}:${capabilities[flag] ? '1' : '0'}`).join('|');
}

/** True when this vendor still needs the disclosure before it may run a turn. */
export function needsExternalDisclosure(
  accepted: ExternalAgentDisclosure | undefined,
  capabilities: ExternalAgentCapabilities
): boolean {
  if (!accepted) return true;
  if (accepted.version !== EXTERNAL_DISCLOSURE_VERSION) return true;
  return accepted.capabilitiesFingerprint !== externalCapabilitiesFingerprint(capabilities);
}

/**
 * Everything a re-prompt should depend on, in one value.
 *
 * Three materials, and the third is why this exists rather than reusing
 * {@link externalCapabilitiesFingerprint} alone:
 *
 * 1. **The disclosure text version** — MangoStudio changed what it said.
 * 2. **The vendor's declared capability set** — the CLI can now do something it
 *    could not when the user agreed. An agent that could not run commands then
 *    and can now is a different disclosure.
 * 3. **The resolved effective permission default** — what actually runs without
 *    asking, right now, on this account.
 *
 * (3) is the one that would otherwise slip through. Claude Code's default
 * permission mode moves from `manual` to `auto` for Pro, Max and Team accounts
 * on 2026-08-14. Nothing about MangoStudio changes and nothing about the CLI's
 * capability flags changes — but the risk the user acknowledged goes from "reads
 * only without asking" to "everything, with a classifier reviewing each action".
 * Consent given for the first must not silently cover the second.
 *
 * Order-independent by construction and stable across processes: it is compared
 * against a stored string, so a `Set` iteration order or a locale-sensitive
 * sort would make every restart look like a change.
 */
export function externalDisclosureContextFingerprint(input: {
  readonly capabilities: ExternalAgentCapabilities;
  /**
   * The vendor's own id for the `(default, user)` combination this account
   * resolves to — `default` or `auto` for Claude, a profile id for Codex.
   *
   * Absent when the adapter did not name one, which is itself a stable input:
   * an adapter that starts naming one has told the user something new.
   */
  readonly effectivePermissionDefault?: string;
}): string {
  return [
    `v:${EXTERNAL_DISCLOSURE_VERSION}`,
    `caps:${externalCapabilitiesFingerprint(input.capabilities)}`,
    `default:${input.effectivePermissionDefault ?? 'unknown'}`,
  ].join('|');
}

/**
 * The `(default, user)` pair's vendor id, which is what the fingerprint tracks.
 *
 * `default` + `user` specifically: it is the combination almost everyone runs,
 * and it is the one whose meaning the vendor can change underneath a stored
 * acknowledgement. An unsupported cell contributes nothing rather than a
 * misleading id, because a combination that cannot be selected describes no risk
 * anyone is exposed to.
 */
export function effectivePermissionDefaultOf(
  configurations: readonly {
    readonly level: string;
    readonly routing: string;
    readonly supported: boolean;
    readonly vendorId?: string;
  }[]
): string | undefined {
  return configurations.find(
    (configuration) =>
      configuration.level === 'default' &&
      configuration.routing === 'user' &&
      configuration.supported
  )?.vendorId;
}
