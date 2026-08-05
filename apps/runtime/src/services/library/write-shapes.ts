/**
 * The shapes a prepared library write is described by, on either side of the
 * protocol.
 *
 * Their own module because both ends need them and neither may own them: the
 * engines act on these operations, `methods.ts` declares the wire types as
 * these plus an encoding, and `methods.ts` is already reachable from the
 * engines' own dependencies. Declared once, so a field added here cannot
 * compile on one side and be dropped on the other.
 *
 * Types only — nothing here imports a filesystem.
 */

import type {
  AdapterStrategy,
  AdaptNote,
  AdaptProvenance,
  LibraryLocationId,
  PropagationApplied,
} from '@mangostudio/shared/library';

export interface PreparedPropagationAdaptation {
  readonly strategy: AdapterStrategy;
  readonly lossy: boolean;
  readonly requiresReview: boolean;
  readonly notes: readonly AdaptNote[];
  readonly provenance?: AdaptProvenance;
}

export interface PreparedPropagationOperation {
  readonly resourceKey: string;
  readonly locationId: LibraryLocationId;
  readonly slug: string;
  readonly operation: Extract<
    PropagationApplied['operation'],
    'create' | 'overwrite' | 'adapt-create' | 'adapt-overwrite'
  >;
  readonly kind: 'file' | 'directory';
  readonly expectedContentHash: string;
  /** Location root the preview showed, as resolved on the hub. */
  readonly destinationRoot: string;
  /** Directory writes on the machine that holds the source. */
  readonly sourceDir?: string;
  /**
   * Directory writes whose source is on another machine: the tree travelled in
   * the frame. Exactly one of this and `sourceDir` is ever set.
   */
  readonly files?: readonly PreparedPropagationFile[];
  readonly contents?: string | Uint8Array;
  readonly adaptation?: PreparedPropagationAdaptation;
}

/** One file of a transferred directory resource. */
export interface PreparedPropagationFile {
  /** Posix-separated, relative to the resource root. */
  readonly relativePath: string;
  readonly contents: Uint8Array;
}

export interface PreparedRemovalOperation {
  readonly resourceKey: string;
  readonly locationId: LibraryLocationId;
  readonly slug: string;
  readonly kind: 'file' | 'directory';
  readonly expectedPath: string;
  readonly expectedContentHash: string;
  readonly lastCopy: boolean;
}
