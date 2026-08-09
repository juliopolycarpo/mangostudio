/**
 * D4's two product axes, expressed in Codex's own fields.
 *
 * Codex is the one vendor where the axes are genuinely independent: `sandbox` +
 * `approvalPolicy` decide what the agent may do, `approvalsReviewer` decides who
 * answers the prompts, and `auto_review` applies at *any* sandbox level. That is
 * why the product vocabulary has two axes at all — a flat four-item list could
 * not express "read-only **and** auto-reviewed" — and why this adapter returns
 * the full 2 × 3 matrix while Cursor and Claude will return less.
 *
 * What narrows the matrix is the machine, not this table.
 * `permissionProfile/list` reports live, config-layer-aware profiles with an
 * `allowed` flag reflecting whether effective requirements permit selecting
 * each one. A profile the user's own configuration forbids comes back
 * `supported: false` with a reason that reads as **policy**, because that is
 * what it is: someone decided this, and telling them MangoStudio cannot do it
 * would be a lie about whose limitation it is.
 */

import type {
  ExternalApprovalRouting,
  ExternalPermissionLevel,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_APPROVAL_ROUTINGS,
  EXTERNAL_PERMISSION_LEVELS,
} from '@mangostudio/shared/external-agents';
import type { ApprovalsReviewer } from './protocol/v2/ApprovalsReviewer';
import type { AskForApproval } from './protocol/v2/AskForApproval';
import type { PermissionProfileSummary } from './protocol/v2/PermissionProfileSummary';

/** The built-in profile each neutral level selects, as `permissionProfile/list` names them. */
export const CODEX_PERMISSION_PROFILE_IDS: Readonly<Record<ExternalPermissionLevel, string>> = {
  'read-only': ':read-only',
  default: ':workspace',
  'full-access': ':danger-full-access',
};

/**
 * `approvalPolicy` per level.
 *
 * `never` pairs with `full-access` because a sandbox that permits everything has
 * nothing left to ask about; asking anyway would train the user to approve
 * without reading. `on-request` everywhere else is what makes the approval path
 * real rather than theoretical.
 *
 * The `granular` object member of `AskForApproval` is deliberately unused: none
 * of the three neutral levels needs per-category control, and a future
 * finer-grained mode should arrive as its own decision rather than by widening
 * this one.
 */
export function encodeApprovalPolicy(level: ExternalPermissionLevel): AskForApproval {
  return level === 'full-access' ? 'never' : 'on-request';
}

/** `approvalsReviewer` per routing. `guardian_subagent` is legacy and never sent. */
export function encodeApprovalsReviewer(routing: ExternalApprovalRouting): ApprovalsReviewer {
  return routing === 'auto-review' ? 'auto_review' : 'user';
}

/**
 * The 2 × 3 matrix, minus whatever the machine's configuration forbids.
 *
 * A profile missing from `permissionProfile/list` entirely is treated exactly
 * like one reported `allowed: false`. Both mean the same thing to the person
 * looking at the selector — this machine will not run that — and inventing a
 * supported combination for a profile the vendor did not list would produce a
 * choice that fails at `thread/start`.
 */
export function buildSupportedConfigurations(
  profiles: readonly PermissionProfileSummary[]
): ExternalSupportedConfiguration[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return matrix((level) => {
    const allowed = byId.get(CODEX_PERMISSION_PROFILE_IDS[level])?.allowed === true;
    return allowed ? undefined : 'externalAgents.unsupported.codexProfileDisallowed';
  });
}

/**
 * The same matrix, wholly unavailable for one reason.
 *
 * A machine that has Codex but cannot run it — a binary older than the pinned
 * contract, say — still has to describe the choices it is refusing. Returning
 * an empty list would read as "this target has no configurations", which is a
 * different and less useful statement than "these are the configurations, and
 * here is why none of them can be selected right now".
 */
export function unsupportedConfigurations(reasonKey: string): ExternalSupportedConfiguration[] {
  return matrix(() => reasonKey);
}

function matrix(
  unsupportedReasonFor: (level: ExternalPermissionLevel) => string | undefined
): ExternalSupportedConfiguration[] {
  const configurations: ExternalSupportedConfiguration[] = [];
  for (const level of EXTERNAL_PERMISSION_LEVELS) {
    const reasonKey = unsupportedReasonFor(level);
    for (const routing of EXTERNAL_APPROVAL_ROUTINGS) {
      configurations.push({
        level,
        routing,
        supported: reasonKey === undefined,
        vendorId: CODEX_PERMISSION_PROFILE_IDS[level],
        // Nothing stops to ask: either the sandbox permits everything, or a
        // subagent is answering the prompts instead of a person.
        unattended: level === 'full-access' || routing === 'auto-review',
        ...(reasonKey === undefined ? {} : { unsupportedReasonKey: reasonKey }),
      });
    }
  }
  return configurations;
}
