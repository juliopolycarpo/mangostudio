/**
 * What the hub offers beside a turn that ended in a vendor error.
 *
 * Today that is one thing: a turn the agent refused because its account is signed out ends with
 * the SDK's `acp-auth-required` code, and the person's next step is the same sign-in command the
 * pre-send check already shows for a `signed-out` agent. The command comes from the product
 * descriptor for the target (the one source the pre-send remedy reads), never from the vendor's
 * error text, so vendor text cannot become the command a user is told to run and copy.
 */

import {
  type ExternalAgentError,
  type ExternalAgentRemedy,
  type ExternalAgentTargetId,
  externalRemedyForError,
} from '@mangostudio/shared/external-agents';
import { productDescriptorFor } from './adapter-descriptors';

/**
 * The remedy for `error` on `targetId`, or `undefined` when the error has none.
 *
 * @example
 * turnErrorRemedyFor('cursor', { code: 'acp-auth-required', message: '…' });
 * // { kind: 'sign-in', command: 'cursor-agent login' }
 */
export function turnErrorRemedyFor(
  targetId: ExternalAgentTargetId,
  error: ExternalAgentError
): ExternalAgentRemedy | undefined {
  const loginCommand = productDescriptorFor(targetId)?.loginCommand;
  return externalRemedyForError(error, loginCommand ? { loginCommand } : {});
}
