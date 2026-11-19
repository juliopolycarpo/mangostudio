/**
 * What the composer's built-in slash commands decide, as pure functions
 * (issue #2599). The names live in `@mangostudio/shared/library` because the
 * hub must agree on them; this file is only the client's half — which ones are
 * on offer for this composer, and what `/model <text>` means.
 */

import type { ModelOption } from '@mangostudio/shared/catalog';
import {
  BUILT_IN_SLASH_COMMANDS,
  type BuiltInSlashCommandName,
} from '@mangostudio/shared/library/values';
import type { ProviderType } from '@mangostudio/shared/types';

export type ModelChoice =
  | { readonly kind: 'match'; readonly model: ModelOption }
  | { readonly kind: 'ambiguous'; readonly models: readonly ModelOption[] }
  | { readonly kind: 'none' };

/**
 * The model `/model <query>` names, among the ones the selector would let the
 * user pick.
 *
 * An exact id or display name wins outright, so `gpt-5` is not ambiguous with
 * `gpt-5-mini`. Otherwise the query is a fragment, which must fit exactly one
 * model: picking the first of several would switch the chat to a model the user
 * did not name. A locked chat only ever sees its own provider's models, the
 * same rows `ModelSelector` leaves enabled.
 * // Usage: resolveModelChoice('mini', models, null)
 */
export function resolveModelChoice(
  query: string,
  models: readonly ModelOption[],
  lockedProvider: ProviderType | null | undefined
): ModelChoice {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { kind: 'none' };

  const selectable = models.filter(
    (candidate) => lockedProvider == null || candidate.provider === lockedProvider
  );
  const exact = selectable.filter(
    (candidate) =>
      candidate.modelId.toLowerCase() === needle || candidate.displayName.toLowerCase() === needle
  );
  const matches =
    exact.length > 0
      ? exact
      : selectable.filter(
          (candidate) =>
            candidate.modelId.toLowerCase().includes(needle) ||
            candidate.displayName.toLowerCase().includes(needle)
        );

  const [only] = matches;
  if (matches.length === 0 || only === undefined) return { kind: 'none' };
  return matches.length === 1
    ? { kind: 'match', model: only }
    : { kind: 'ambiguous', models: matches };
}

interface BuiltInAvailability {
  /** An external runner's vendor owns the `/` namespace, so none apply. */
  readonly isExternalRunner: boolean;
  /** Whether the composer was handed a way to open a new chat. */
  readonly canStartChat: boolean;
  /** A chat exists, the catalog has answered and the selector is not disabled. */
  readonly canSwitchModel: boolean;
}

/**
 * The built-ins this composer can run right now, in palette order. A command
 * whose action is missing is not offered rather than offered and ignored.
 * // Usage: availableBuiltIns({ isExternalRunner: false, canStartChat: true, canSwitchModel: false }) // ['clear']
 */
export function availableBuiltIns({
  isExternalRunner,
  canStartChat,
  canSwitchModel,
}: BuiltInAvailability): readonly BuiltInSlashCommandName[] {
  if (isExternalRunner) return [];
  return BUILT_IN_SLASH_COMMANDS.filter((name) =>
    name === 'clear' ? canStartChat : canSwitchModel
  );
}
