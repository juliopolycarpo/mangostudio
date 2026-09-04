/**
 * Named permission choices, for people who should not have to learn a matrix.
 *
 * The two axes are honest and they are also two questions a non-expert did not
 * ask. "What may it do" crossed with "who approves" is six cells, three of
 * which no vendor offers and one of which is dangerous — and the user's actual
 * question is "how much should this bother me". A preset answers *that*, and
 * the matrix stays underneath for anyone who wants it.
 *
 * Not in `permissions.ts`: that file is about reading a **persisted** choice
 * back restrictively, and says so in its first line. A preset is a way to make
 * a choice, which is a different responsibility with a different failure mode —
 * getting one wrong offers a pair nobody can run, not a privilege nobody
 * granted.
 *
 * **Ordered candidates, resolved per vendor.** The same preset does not mean
 * the same pair everywhere: Claude's `auto` routing is a classifier and is
 * account-gated, Codex's is a sandbox. So each preset lists pairs in
 * preference order and the first one the descriptor reports `supported` wins. A
 * preset with no supported candidate is not offered at all, rather than offered
 * and then refused — a control that cannot work is worse than a control that is
 * not there.
 *
 * Browser-safe: pure data, no Node builtins.
 */

import Type, { type Static } from 'typebox';
import type { ExternalApprovalRouting, ExternalPermissionLevel } from './schemas';

export const ExternalPermissionPresetIdSchema = Type.Union([
  Type.Literal('careful'),
  Type.Literal('balanced'),
  Type.Literal('autonomous'),
]);

export type ExternalPermissionPresetId = Static<typeof ExternalPermissionPresetIdSchema>;

/** One axis pair, in the order a preset would rather have it. */
export interface ExternalPermissionPair {
  readonly level: ExternalPermissionLevel;
  readonly routing: ExternalApprovalRouting;
}

export interface ExternalPermissionPreset {
  readonly id: ExternalPermissionPresetId;
  /** Tried in order; the first the vendor supports is what this preset means here. */
  readonly candidates: readonly ExternalPermissionPair[];
}

/**
 * The three, ordered from most to least supervised.
 *
 * `autonomous` lists `full-access × user` **first** and `default × auto-review`
 * second, which looks backwards until you read `permission-matrix.ts`: both are
 * `unattended`, and the first is the one every vendor can express. The second
 * is Claude's account-gated classifier, so leading with it would leave the
 * preset greyed out for most users of the other two vendors.
 */
export const EXTERNAL_PERMISSION_PRESETS: readonly ExternalPermissionPreset[] = [
  { id: 'careful', candidates: [{ level: 'read-only', routing: 'user' }] },
  { id: 'balanced', candidates: [{ level: 'default', routing: 'user' }] },
  {
    id: 'autonomous',
    candidates: [
      { level: 'full-access', routing: 'user' },
      { level: 'default', routing: 'auto-review' },
    ],
  },
];

/** Just the ids, for an i18n parity table that has to cover every one. */
export const EXTERNAL_PERMISSION_PRESET_IDS: readonly ExternalPermissionPresetId[] =
  EXTERNAL_PERMISSION_PRESETS.map((preset) => preset.id);

/** What a descriptor has to answer for a pair to be offered. */
export interface ExternalPermissionSupport {
  readonly level: ExternalPermissionLevel;
  readonly routing: ExternalApprovalRouting;
  readonly supported: boolean;
}

/**
 * The pair a preset means for this vendor, or `undefined` when it means none.
 *
 * @example
 * externalPresetPair(EXTERNAL_PERMISSION_PRESETS[0], descriptor.supportedConfigurations);
 * // { level: 'read-only', routing: 'user' }
 */
export function externalPresetPair(
  preset: ExternalPermissionPreset,
  configurations: readonly ExternalPermissionSupport[]
): ExternalPermissionPair | undefined {
  return preset.candidates.find((candidate) =>
    configurations.some(
      (configuration) =>
        configuration.level === candidate.level &&
        configuration.routing === candidate.routing &&
        configuration.supported
    )
  );
}

/**
 * Which preset a pair *is*, so a stored choice can select its own row.
 *
 * Matched against the candidate list rather than against the resolved pair, so
 * a chat sitting on `default × auto-review` still reads as `autonomous` on a
 * vendor where `full-access × user` would have been chosen instead.
 *
 * `undefined` means the pair is a custom one, which is what opens the matrix.
 */
export function externalPresetFor(
  pair: ExternalPermissionPair
): ExternalPermissionPresetId | undefined {
  return EXTERNAL_PERMISSION_PRESETS.find((preset) =>
    preset.candidates.some(
      (candidate) => candidate.level === pair.level && candidate.routing === pair.routing
    )
  )?.id;
}
