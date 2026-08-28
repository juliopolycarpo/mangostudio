/**
 * The third-party disclosure, enforced rather than displayed.
 *
 * Handing a conversation to a vendor CLI is a notice obligation, and plan 006
 * already recorded an acknowledgement in settings so the browser could decide
 * whether to show a modal. That is a courtesy, not a safeguard: it is checked by
 * the one client that happens to implement it, and the external API — the same
 * turn, the same vendor, the same data leaving for the same company — never saw
 * it at all. This makes the acknowledgement a **precondition the server checks**,
 * on every path that can start a turn.
 *
 * Applies to every vendor, not only Claude. The exposure is identical — another
 * company's software, its own terms, its own billing, its own tools — and a
 * Claude-only gate would be an asymmetry with no defensible reason behind it.
 *
 * Three properties this module exists to hold:
 *
 * - **Fail closed.** No row, an unreadable row, a row from an older text
 *   version, and a row whose context fingerprint no longer matches all mean the
 *   same thing: ask again. The failure to prefer is one extra dialog.
 * - **A fingerprint is only compared against an adapter's answer.** The cheap
 *   discovery pass reports every capability false because it never asked, and
 *   fingerprinting that placeholder would make an ordinary cold cache look like
 *   a vendor that changed. Unknown is not stale, and it is not consent either:
 *   the row still has to exist and still has to carry the current text version.
 * - **No back door.** There is no configuration flag and no environment
 *   variable that satisfies the gate. The same reasoning as the isolation
 *   attestation: a notice obligation that the party under it can switch off is
 *   not an obligation.
 * - **Per vendor.** Acknowledging Anthropic's terms says nothing about
 *   OpenAI's, and the table's primary key is what makes that structural rather
 *   than conventional.
 */

import type {
  ExternalAgentCapabilities,
  ExternalAgentTargetId,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_DISCLOSURE_VERSION,
  effectivePermissionDefaultOf,
  externalDisclosureContextFingerprint,
} from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';

/** What the disclosure covered, as the descriptor that would run the turn reports it. */
export interface ExternalDisclosureContext {
  readonly capabilities: ExternalAgentCapabilities;
  readonly supportedConfigurations: readonly ExternalSupportedConfiguration[];
}

export interface ExternalDisclosureScope {
  readonly userId: string;
  readonly targetId: ExternalAgentTargetId;
}

/**
 * The digest a stored acknowledgement is compared against.
 *
 * Derived from the live descriptor every time rather than stored alongside the
 * row, so a vendor that quietly gains a capability or an account whose effective
 * default flips is noticed on the next send instead of on the next release.
 */
export function disclosureContextFingerprint(context: ExternalDisclosureContext): string {
  const effectivePermissionDefault = effectivePermissionDefaultOf(context.supportedConfigurations);
  return externalDisclosureContextFingerprint({
    capabilities: context.capabilities,
    ...(effectivePermissionDefault !== undefined ? { effectivePermissionDefault } : {}),
  });
}

/**
 * Whether this vendor still needs an acknowledgement before it may run.
 *
 * Both halves of the comparison matter and neither implies the other: the
 * version catches MangoStudio changing what it said, the fingerprint catches the
 * vendor or the account changing what it does.
 *
 * `null` is not a third stale reason — it means **no adapter answered**, so
 * nothing is known about what this vendor can do here. Only the row itself is
 * checked in that case. Comparing anyway would fingerprint the cheap pass's
 * placeholder, which is every capability false and no effective default, and
 * that value can never match an acknowledgement recorded from a real answer: the
 * gate would re-prompt on every cold cache — a page reload, a sign-in, a
 * reconnect — for consent nobody withdrew. A dialog that reappears for no reason
 * the user can act on is the one that teaches people to click through it.
 */
export async function requiresExternalDisclosure(
  scope: ExternalDisclosureScope,
  context: ExternalDisclosureContext | null,
  db: Kysely<Database>
): Promise<boolean> {
  const row = await db
    .selectFrom('external_agent_disclosures')
    .select(['disclosureVersion', 'contextFingerprint'])
    .where('userId', '=', scope.userId)
    .where('targetId', '=', scope.targetId)
    .executeTakeFirst();

  if (!row) return true;
  if (row.disclosureVersion !== EXTERNAL_DISCLOSURE_VERSION) return true;
  if (!context) return false;
  return row.contextFingerprint !== disclosureContextFingerprint(context);
}

/**
 * Records the acknowledgement, replacing any earlier one for this vendor.
 *
 * The fingerprint is computed here from the descriptor rather than accepted from
 * the caller. A client that could send its own would be able to acknowledge a
 * disclosure it was never shown — including one for a capability set the vendor
 * does not have — which is the whole gate defeated by a request body.
 */
export async function acknowledgeExternalDisclosure(
  scope: ExternalDisclosureScope,
  context: ExternalDisclosureContext,
  db: Kysely<Database>,
  now: () => number = Date.now
): Promise<void> {
  const values = {
    userId: scope.userId,
    targetId: scope.targetId,
    disclosureVersion: EXTERNAL_DISCLOSURE_VERSION,
    contextFingerprint: disclosureContextFingerprint(context),
    acknowledgedAt: now(),
  };
  await db
    .insertInto('external_agent_disclosures')
    .values(values)
    .onConflict((conflict) =>
      conflict.columns(['userId', 'targetId']).doUpdateSet({
        disclosureVersion: values.disclosureVersion,
        contextFingerprint: values.contextFingerprint,
        acknowledgedAt: values.acknowledgedAt,
      })
    )
    .execute();
}

/** One user's acknowledgement, for the settings page that lists and revokes them. */
export interface ExternalDisclosureRecord {
  readonly targetId: string;
  readonly disclosureVersion: number;
  readonly acknowledgedAt: number;
}

export async function listExternalDisclosures(
  userId: string,
  db: Kysely<Database>
): Promise<readonly ExternalDisclosureRecord[]> {
  return await db
    .selectFrom('external_agent_disclosures')
    .select(['targetId', 'disclosureVersion', 'acknowledgedAt'])
    .where('userId', '=', userId)
    .orderBy('targetId')
    .execute();
}

/**
 * Withdraws an acknowledgement.
 *
 * Deleting the row blocks the next start. Stopping what is already running is
 * the caller's job and is not optional — revoking a disclosure while a vendor
 * process keeps running for that user would leave the exact thing the user just
 * refused still happening. `external-agent-routes.ts` pairs this with a reap for
 * that reason.
 */
export async function revokeExternalDisclosure(
  scope: ExternalDisclosureScope,
  db: Kysely<Database>
): Promise<void> {
  await db
    .deleteFrom('external_agent_disclosures')
    .where('userId', '=', scope.userId)
    .where('targetId', '=', scope.targetId)
    .execute();
}
