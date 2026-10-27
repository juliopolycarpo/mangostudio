import type { Message } from '@mangostudio/shared/chat';
import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents/values';
import type { MessagePart } from '@mangostudio/shared/types';

import {
  deriveMonogram,
  type ResolvedToolIdentity,
} from '@/features/environments/identity/resolve';

/**
 * Who produced a turn, in the two forms the app can actually draw.
 *
 * `agent` is a hosted vendor CLI, which has a configurable identity: storage, an
 * edit dialog, an avatar palette. `model` is everything else — a model id is a
 * name, not a subject, and there is nowhere to store an override for it.
 */
export type TurnIdentity =
  | { readonly kind: 'agent'; readonly targetId: ExternalAgentTargetId }
  | {
      readonly kind: 'model';
      readonly name: string;
      readonly monogram: string;
      /**
       * The id the turn stored, when it stored one. Kept beside the name so the
       * exact value stays reachable (a tooltip) once the name is friendlier, and
       * so a name that *is* the id can be told from one that was looked up.
       */
      readonly modelId: string | null;
    };

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
 * What the chat calls a hosted agent: the person's own name for it, else the
 * runner's product name — "Codex CLI", the word the runner picker, the composer
 * placeholder and the disclaimer use on the same screen.
 *
 * The identity's derived name comes from the environments dictionary ("Codex"),
 * which names the installed program; a turn header saying "Codex" under a
 * picker saying "Codex CLI" gave one runner two names. Only the name changes:
 * the avatar keeps the identity's own monogram, since "Codex CLI", "Cursor CLI"
 * and "Claude Code" would all derive "CC".
 *
 * Usage: agentRunnerName(resolve('agent', 'codex'), 'codex', t.externalAgents.target)
 */
export function agentRunnerName(
  identity: ResolvedToolIdentity,
  targetId: ExternalAgentTargetId,
  targets: TargetLabels
): string {
  return identity.storedName ?? targets[targetId];
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
 * A model the catalog knows is named the way the composer names it
 * (`Claude Sonnet 4.5`, not `claude-sonnet-4-5-20250929`); one it no longer
 * lists keeps its stored id, which is all the transcript has left of it.
 *
 * Usage: deriveTurnIdentity(msg, parts, t.externalAgents.target, 'AI model', modelNames)
 */
export function deriveTurnIdentity(
  msg: Message,
  parts: readonly MessagePart[],
  targets: TargetLabels,
  fallbackName: string,
  modelNames?: ReadonlyMap<string, string>
): TurnIdentity {
  const externalTurn = parts.find((part) => part.type === 'external_turn');
  if (externalTurn?.type === 'external_turn') {
    return { kind: 'agent', targetId: externalTurn.targetId };
  }
  const modelId = msg.modelName ?? null;
  const name = modelId
    ? (modelNames?.get(modelId) ?? modelDisplayName(modelId, targets))
    : fallbackName;
  return { kind: 'model', name, monogram: deriveMonogram(name), modelId };
}
