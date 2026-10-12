/**
 * How the hub presents a send the runtime refused while it was opening the session.
 *
 * The preflight already refuses a target that is signed out or denied, but it reads a cached
 * descriptor; the open reads the machine as it is now, so a login that lapsed, or a consent that was
 * withdrawn, in between reaches the stream as a failed open. Without this the person sees one
 * generic sentence. The presentation is the one the selector and the pre-send refusal already use:
 * an unavailable reason (said in the client's words) and its remedy, from the same tables.
 *
 * Only open-time failures with an existing presentation are here. Every other one stays generic.
 */

import { RemoteError } from '@mangostudio/protocol';
import {
  type ExternalAgentRemedy,
  type ExternalAgentTargetId,
  type ExternalAgentUnavailableReason,
  externalRemedyFor,
} from '@mangostudio/shared/external-agents';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';
import { productDescriptorFor } from './adapter-descriptors';

/** The runtime's open-time error kinds that name an existing unavailable reason. */
const OPEN_REFUSAL_REASONS = {
  external_agent_signed_out: 'signed-out',
} as const satisfies Record<string, ExternalAgentUnavailableReason>;

export interface OpenRefusalPresentation {
  readonly unavailableReason: ExternalAgentUnavailableReason;
  readonly remedy: ExternalAgentRemedy;
}

/**
 * The presentation for a failed open, or `undefined` when the failure has none.
 *
 * Walks `cause` a few links, as the submission policy does, because the hub's own wrappers keep
 * the runtime's answer there. The sign-in command is the target's, from the product descriptor;
 * nothing in the runtime's message is used.
 *
 * @example
 * openRefusalFor('cursor', new RemoteError('UNAVAILABLE', 'signed out', { kind: 'external_agent_signed_out' }));
 * // { unavailableReason: 'signed-out', remedy: { kind: 'sign-in', command: 'cursor-agent login' } }
 */
export function openRefusalFor(
  targetId: ExternalAgentTargetId,
  error: unknown
): OpenRefusalPresentation | undefined {
  const reason = reasonOf(error);
  if (!reason) return undefined;
  const loginCommand = productDescriptorFor(targetId)?.loginCommand;
  const remedy = externalRemedyFor(reason, loginCommand ? { loginCommand } : {});
  return remedy ? { unavailableReason: reason, remedy } : undefined;
}

function reasonOf(error: unknown): ExternalAgentUnavailableReason | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof RuntimeConsentDeniedError) return 'runtime-denied';
    if (current instanceof RemoteError) {
      const kind = current.details?.kind;
      if (typeof kind === 'string' && Object.hasOwn(OPEN_REFUSAL_REASONS, kind)) {
        return OPEN_REFUSAL_REASONS[kind as keyof typeof OPEN_REFUSAL_REASONS];
      }
    }
    current = current.cause;
  }
  return undefined;
}
