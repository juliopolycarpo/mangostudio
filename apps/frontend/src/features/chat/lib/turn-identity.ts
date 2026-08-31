import type { Message, MessagePart } from '@mangostudio/shared';
import {
  type ExternalAgentTargetId,
  isExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { deriveMonogram } from '@/features/environments/identity/resolve';

/**
 * Who produced a turn, in the two forms the app can actually draw.
 *
 * `agent` is a hosted vendor CLI, which has a configurable identity: storage, an
 * edit dialog, an avatar palette. `model` is everything else — a model id is a
 * name, not a subject, and there is nowhere to store an override for it.
 */
export type TurnIdentity =
  | { readonly kind: 'agent'; readonly targetId: ExternalAgentTargetId }
  | { readonly kind: 'model'; readonly name: string; readonly monogram: string };

/** The `externalAgents.target` slice of the dictionary, passed in to stay i18n-free. */
type TargetLabels = Record<ExternalAgentTargetId, string>;

/**
 * What to call the thing that produced the turn.
 *
 * An external turn stores `configuration.model ?? targetId`, so a vendor that
 * resolved no model leaves its own id here. That id is a wire value, not a
 * name — rendering it raw would put `codex` in front of the user where the
 * vendor already has a translated label.
 *
 * The match is exact: `claude` is a target id, and `claude-opus-4` is a model
 * that merely starts with one. A prefix test would relabel the model as the
 * vendor and hide which model actually answered.
 *
 */
function modelDisplayName(modelName: string, targets: TargetLabels): string {
  return isExternalAgentTargetId(modelName) ? targets[modelName] : modelName;
}

/**
 * Resolves the turn's producer to something drawable.
 *
 * A turn carrying an `external_turn` part is owned by a hosted agent, and
 * `agent:<targetId>` is already a valid identity subject — so renaming Codex in
 * Environments renames it here for free. Everything else is a model: the
 * identity kinds are a closed union with no `model` member and `parseSubjectKey`
 * validates the id against its kind, so a `model:gpt-5` subject key would be a
 * key the API rejects and no user could ever edit. It gets a plain monogram
 * instead, derived from the same name the reader sees.
 *
 * Usage: deriveTurnIdentity(msg, parts, t.externalAgents.target, 'AI model')
 */
export function deriveTurnIdentity(
  msg: Message,
  parts: readonly MessagePart[],
  targets: TargetLabels,
  fallbackName: string
): TurnIdentity {
  const externalTurn = parts.find((part) => part.type === 'external_turn');
  if (externalTurn?.type === 'external_turn') {
    return { kind: 'agent', targetId: externalTurn.targetId };
  }
  const name = msg.modelName ? modelDisplayName(msg.modelName, targets) : fallbackName;
  return { kind: 'model', name, monogram: deriveMonogram(name) };
}
