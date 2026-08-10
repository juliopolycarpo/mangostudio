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

import { type Static, Type } from '@sinclair/typebox';
import type { ExternalAgentCapabilities } from './schemas';
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
 * One acknowledgement per vendor. Absent means the user has not been asked —
 * which is why every key is optional, and why a missing key can never read as
 * consent.
 */
export const ExternalAgentSettingsSchema = Type.Object({
  disclosures: Type.Partial(
    Type.Record(ExternalAgentTargetIdSchema, ExternalAgentDisclosureSchema, {
      additionalProperties: false,
    })
  ),
});

export type ExternalAgentSettings = Static<typeof ExternalAgentSettingsSchema>;

export const DEFAULT_EXTERNAL_AGENT_SETTINGS: ExternalAgentSettings = { disclosures: {} };

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
