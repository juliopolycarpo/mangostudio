/**
 * Which Node and Bun a spawned process runs with, per environment.
 *
 * Split out of `schemas.ts` on purpose: `schemas.ts` pulls in
 * `runtime-protocol/schemas` and `runtime-home/schemas`, and both of those pull
 * in `external-agents/schemas` — which needs `ToolchainSelectionSchema` too
 * (`external-agent.open` carries a toolchain choice). Importing it from
 * `schemas.ts` would close that loop into a real import cycle; this file has no
 * imports of its own, so nothing can cycle back through it.
 */

import Type, { type Static } from 'typebox';

/**
 * Which installation a spawned process runs with. `auto` is what a login shell
 * would see, computed without executing profiles; a path is the realpath of one
 * installation the probe already returned.
 */
export const ToolchainChoiceSchema = Type.Union([
  Type.Literal('auto'),
  Type.String({ minLength: 1, maxLength: 4_096 }),
]);

export const ToolchainSelectionSchema = Type.Object(
  {
    node: ToolchainChoiceSchema,
    bun: ToolchainChoiceSchema,
  },
  { additionalProperties: false }
);

export const ToolchainUpdateBodySchema = Type.Object(
  {
    node: Type.Optional(ToolchainChoiceSchema),
    bun: Type.Optional(ToolchainChoiceSchema),
  },
  { additionalProperties: false, minProperties: 1 }
);

export const DEFAULT_TOOLCHAIN_SELECTION: Static<typeof ToolchainSelectionSchema> = {
  node: 'auto',
  bun: 'auto',
};

export type ToolchainChoice = Static<typeof ToolchainChoiceSchema>;
export type ToolchainSelection = Static<typeof ToolchainSelectionSchema>;
export type ToolchainUpdateBody = Static<typeof ToolchainUpdateBodySchema>;
