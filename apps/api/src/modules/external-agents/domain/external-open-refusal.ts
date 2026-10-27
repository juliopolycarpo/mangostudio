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
 * A missing executable is told apart from a workspace or configuration refusal by its own runtime
 * kind (`external_agent_not_installed`), never by the message.
 */

import { RemoteError } from '@mangostudio/protocol';
import {
  type ExternalAgentRemedy,
  type ExternalAgentTargetId,
  type ExternalAgentUnavailableReason,
  externalRemedyFor,
  isExternalAgentKindCode,
} from '@mangostudio/shared/external-agents';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';

import { productDescriptorFor } from './adapter-descriptors';

/** The runtime's open-time error kinds that name an existing unavailable reason. */
const OPEN_REFUSAL_REASONS = {
  external_agent_signed_out: 'signed-out',
  external_agent_not_installed: 'not-installed',
  external_agent_version_unsupported: 'version-unsupported',
} as const satisfies Record<string, ExternalAgentUnavailableReason>;

/** Matches `ExternalAgentDescriptorSchema.requiredVersion`, which the stream chunk repeats. */
const MAX_REQUIRED_VERSION_LENGTH = 64;

export interface OpenRefusalPresentation {
  readonly unavailableReason: ExternalAgentUnavailableReason;
  readonly remedy: ExternalAgentRemedy;
  /** The build that would clear `version-unsupported`, as the runtime's structured detail names it. */
  readonly requiredVersion?: string;
}

/**
 * The presentation for a failed open, or `undefined` when the failure has none.
 *
 * Walks `cause` a few links, as the submission policy does, because the hub's own wrappers keep
 * the runtime's answer there. The sign-in command is the target's, from the product descriptor;
 * the required version is the runtime's structured `requiredVersion` detail (the SDK's own
 * minimum, the value discovery reports on the descriptor), bounded and trimmed. Nothing in the
 * runtime's message is used.
 *
 * @example
 * openRefusalFor('cursor', new RemoteError('UNAVAILABLE', 'signed out', { kind: 'external_agent_signed_out' }));
 * // { unavailableReason: 'signed-out', remedy: { kind: 'sign-in', command: 'cursor-agent login' } }
 */
export function openRefusalFor(
  targetId: ExternalAgentTargetId,
  error: unknown
): OpenRefusalPresentation | undefined {
  const found = refusalOf(error);
  if (!found) return undefined;
  const { reason, requiredVersion } = found;
  const loginCommand = productDescriptorFor(targetId)?.loginCommand;
  const remedy = externalRemedyFor(reason, loginCommand ? { loginCommand } : {});
  if (!remedy) return undefined;
  return {
    unavailableReason: reason,
    remedy,
    ...(reason === 'version-unsupported' && requiredVersion ? { requiredVersion } : {}),
  };
}

interface FoundRefusal {
  readonly reason: ExternalAgentUnavailableReason;
  readonly requiredVersion: string | undefined;
}

function refusalOf(error: unknown): FoundRefusal | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof RuntimeConsentDeniedError) {
      return { reason: 'runtime-denied', requiredVersion: undefined };
    }
    if (current instanceof RemoteError) {
      const kind = current.details?.kind;
      if (typeof kind === 'string' && Object.hasOwn(OPEN_REFUSAL_REASONS, kind)) {
        return {
          reason: OPEN_REFUSAL_REASONS[kind as keyof typeof OPEN_REFUSAL_REASONS],
          requiredVersion: boundedVersion(current.details?.requiredVersion),
        };
      }
    }
    current = current.cause;
  }
  return undefined;
}

function boundedVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, MAX_REQUIRED_VERSION_LENGTH);
  return trimmed || undefined;
}

/**
 * The `code` the stream's `error` chunk carries for a failed open that has no unavailable reason,
 * or `undefined` when the runtime named no kind.
 *
 * It is the runtime's own kind, read from its structured details and never from its message, and
 * only when it has the shape of an external-agent kind. A runtime at its session cap
 * (`external_agent_capacity`) has copy of its own on the client; every other kind (a launch that
 * failed, a lost link, a protocol or vendor failure) keeps the generic sentence, and the kind is
 * what the person can quote to support.
 *
 * @example
 * openFailureCodeFor(new RemoteError('INTERNAL', 'at capacity', { kind: 'external_agent_capacity' }));
 * // 'external_agent_capacity'
 */
export function openFailureCodeFor(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof RemoteError) {
      const kind = current.details?.kind;
      if (isExternalAgentKindCode(kind)) return kind;
    }
    current = current.cause;
  }
  return undefined;
}
