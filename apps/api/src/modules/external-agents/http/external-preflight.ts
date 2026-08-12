/**
 * How a refused external send reads over HTTP.
 *
 * Every one of these is decided before the response becomes a stream, so they
 * are status codes rather than error frames — a refusal after the 200 is
 * committed reads to a user as a turn that failed, not as one that never began.
 *
 * Shared by the two routes that can open an external turn — the send stream and
 * the review action — because they refuse for the same reasons and a client
 * cannot be asked to learn two different mappings for one vocabulary.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ExternalTurnPreflightFailure } from '../application/external-turn-stream';

export const EXTERNAL_PREFLIGHT_STATUS = {
  conflict: 409,
  unsupported: 409,
  unavailable: 503,
  validation: 400,
  // Not 409: nothing about the request is wrong, and nothing about it will
  // change. What is missing is a decision only the user can make, which the
  // client turns into one dialog and one retry.
  'workspace-trust': 403,
  // Also 403, and also not 409: the request is fine and retrying changes
  // nothing. What is missing is an operator's change to the machine.
  'isolation-unproven': 403,
  // 403 for the same reason `workspace-trust` is: the request is well-formed,
  // and what is missing is one explicit choice the client turns into a dialog.
  'disclosure-required': 403,
  // 400, because the request describes something that cannot be done: there is
  // no repository, so there is no set of uncommitted changes to review. Not
  // 409, which would suggest waiting and retrying would help.
  'review-requires-git': 400,
} as const satisfies Record<ExternalTurnPreflightFailure['kind'], number>;

export const EXTERNAL_PREFLIGHT_CODE = {
  conflict: ERROR_CODES.CONFLICT,
  unsupported: ERROR_CODES.UNSUPPORTED,
  unavailable: ERROR_CODES.PROVIDER_ERROR,
  validation: ERROR_CODES.VALIDATION,
  'workspace-trust': ERROR_CODES.EXTERNAL_WORKSPACE_UNTRUSTED,
  'isolation-unproven': ERROR_CODES.EXTERNAL_ISOLATION_UNPROVEN,
  'disclosure-required': ERROR_CODES.EXTERNAL_DISCLOSURE_REQUIRED,
  'review-requires-git': ERROR_CODES.EXTERNAL_REVIEW_REQUIRES_GIT,
} as const satisfies Record<ExternalTurnPreflightFailure['kind'], string>;

/**
 * The scope a refusal disclosed, when it disclosed one.
 *
 * Two failures carry a `details` object the client acts on rather than only
 * renders: a trust grant is checked against the workspace, vendor and machine
 * the refusal named, and a disclosure is acknowledged against the descriptor the
 * user was shown. Neither can be reconstructed client-side, which is why they
 * travel with the refusal.
 */
export function externalPreflightDetails(
  failure: ExternalTurnPreflightFailure
): { readonly details: Record<string, string> } | Record<string, never> {
  if (failure.kind === 'workspace-trust') {
    return {
      details: {
        workspacePath: failure.workspacePath,
        targetId: failure.targetId,
        environmentId: failure.environmentId,
      },
    };
  }
  if (failure.kind === 'disclosure-required') {
    return { details: { targetId: failure.targetId, environmentId: failure.environmentId } };
  }
  return {};
}
