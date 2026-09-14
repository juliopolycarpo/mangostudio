/**
 * The shapes a prepared library write is described by, on either side of the
 * protocol.
 *
 * Shared because both ends need them and neither may own them: the runtime's
 * engines act on these operations, and the runtime contract declares the wire
 * types as these plus an encoding. Declared once, so a field added here cannot
 * compile on one side and be dropped on the other.
 *
 * Schema-first, with one seam. A propagation operation carries bytes, and bytes
 * are a `Uint8Array` in the engine and base64 in a frame — so the schema here
 * describes everything *except* the payload members, and each side adds its own:
 * the engine in the type alias below, the wire in
 * `runtime-contract/methods/library.ts`. That keeps one declaration of the
 * thirteen members both sides share, which is the part a field gets added to.
 *
 * Nothing here imports a filesystem.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';
import {
  AdapterStrategySchema,
  AdaptNoteSchema,
  AdaptProvenanceSchema,
  LibraryLocationIdSchema,
} from './schemas';

export const PreparedPropagationAdaptationSchema = Type.Object({
  strategy: AdapterStrategySchema,
  lossy: Type.Boolean(),
  requiresReview: Type.Boolean(),
  notes: ReadonlyArraySchema(AdaptNoteSchema),
  provenance: Type.Optional(AdaptProvenanceSchema),
});
export type PreparedPropagationAdaptation = Static<typeof PreparedPropagationAdaptationSchema>;

/** The write a propagation can prepare; `noop` is decided before preparation. */
export const PreparedPropagationOperationKindSchema = Type.Union([
  Type.Literal('create'),
  Type.Literal('overwrite'),
  Type.Literal('adapt-create'),
  Type.Literal('adapt-overwrite'),
]);

/**
 * Everything a prepared propagation carries apart from its payload.
 *
 * Consumed by the engine type below and by the wire schema in the runtime
 * contract; neither declares these members for itself.
 */
export const PreparedPropagationOperationBaseSchema = Type.Object({
  resourceKey: Type.String(),
  locationId: LibraryLocationIdSchema,
  slug: Type.String(),
  operation: PreparedPropagationOperationKindSchema,
  kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  expectedContentHash: Type.String(),
  /** Location root the preview showed, as resolved on the hub. */
  destinationRoot: Type.String(),
  /** Directory writes on the machine that holds the source. */
  sourceDir: Type.Optional(Type.String()),
  adaptation: Type.Optional(PreparedPropagationAdaptationSchema),
});

/** One file of a transferred directory resource. */
export interface PreparedPropagationFile {
  /** Posix-separated, relative to the resource root. */
  readonly relativePath: string;
  readonly contents: Uint8Array;
}

/**
 * A prepared propagation as the engine acts on it: the shared members plus the
 * payload as bytes.
 *
 * `contents` and `files` are the two members that cannot be schema-derived —
 * a `Uint8Array` is not a JSON value — so they are declared here and the wire
 * declares its base64 counterparts.
 */
export type PreparedPropagationOperation = Static<typeof PreparedPropagationOperationBaseSchema> & {
  /**
   * Directory writes whose source is on another machine: the tree travelled in
   * the frame. Exactly one of this and `sourceDir` is ever set.
   */
  readonly files?: readonly PreparedPropagationFile[];
  readonly contents?: string | Uint8Array;
};

export const PreparedRemovalOperationSchema = Type.Object({
  resourceKey: Type.String(),
  locationId: LibraryLocationIdSchema,
  slug: Type.String(),
  kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  expectedPath: Type.String(),
  expectedContentHash: Type.String(),
  lastCopy: Type.Boolean(),
});
export type PreparedRemovalOperation = Static<typeof PreparedRemovalOperationSchema>;
