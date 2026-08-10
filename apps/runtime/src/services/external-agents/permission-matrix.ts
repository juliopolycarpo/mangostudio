/**
 * The 2 × 3 product matrix every adapter answers with, built once.
 *
 * D4's two axes — level and approval routing — are product vocabulary, and each
 * adapter returns the combinations its vendor actually supports. What must not
 * vary between adapters is the *shape* of that answer: the full matrix is always
 * returned, an unsupported pair carries a reason rather than being omitted, and
 * `unattended` means the same thing everywhere.
 *
 * Returning the whole matrix is deliberate. An empty list reads as "this target
 * has no configurations", which is a different and less useful statement than
 * "these are the configurations, and here is why none of them can be selected
 * right now" — and the UI renders the second.
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

/** One cell's verdict, as the adapter that would run it sees the pair. */
export type ExternalConfigurationVerdict =
  | { readonly supported: true; readonly vendorId?: string }
  | { readonly supported: false; readonly reasonKey: string; readonly vendorId?: string };

/**
 * Builds the matrix from a per-cell verdict.
 *
 * `unattended` is owned here rather than by the caller because it is a
 * statement about the product axes, not about a vendor: either the level lets
 * the agent act without asking, or the routing means something other than a
 * person is answering. An adapter that could set it independently could
 * describe a `full-access` pair as attended.
 */
export function externalConfigurationMatrix(
  verdictFor: (
    level: ExternalPermissionLevel,
    routing: ExternalApprovalRouting
  ) => ExternalConfigurationVerdict
): ExternalSupportedConfiguration[] {
  const configurations: ExternalSupportedConfiguration[] = [];
  for (const level of EXTERNAL_PERMISSION_LEVELS) {
    for (const routing of EXTERNAL_APPROVAL_ROUTINGS) {
      const verdict = verdictFor(level, routing);
      configurations.push({
        level,
        routing,
        supported: verdict.supported,
        ...(verdict.vendorId === undefined ? {} : { vendorId: verdict.vendorId }),
        unattended: level === 'full-access' || routing === 'auto-review',
        ...(verdict.supported ? {} : { unsupportedReasonKey: verdict.reasonKey }),
      });
    }
  }
  return configurations;
}
