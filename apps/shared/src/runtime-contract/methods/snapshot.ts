/**
 * The snapshot family: capturing, hashing and reverting the before-state a
 * mutating filesystem call records for the checkpoint ledger.
 *
 * Schema-first, like the other families in this directory — the schema is the
 * source and the type is `Static<>` of it. `snapshot.capture`'s result is
 * {@link RuntimeBeforeSnapshot}, which lives in `./common` and is not
 * redeclared here.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../../schema-helpers';

export const RuntimeSnapshotCaptureParamsSchema = Type.Object({
  path: Type.String(),
});
export type RuntimeSnapshotCaptureParams = Static<typeof RuntimeSnapshotCaptureParamsSchema>;

export const RuntimeSnapshotHashParamsSchema = Type.Object({
  path: Type.String(),
});
export type RuntimeSnapshotHashParams = Static<typeof RuntimeSnapshotHashParamsSchema>;

export const RuntimeSnapshotHashResultSchema = Type.Object({
  hash: Type.Union([Type.String(), Type.Null()]),
});
export type RuntimeSnapshotHashResult = Static<typeof RuntimeSnapshotHashResultSchema>;

export const RuntimeSnapshotRevertParamsSchema = Type.Object({
  chatId: Type.String(),
  /** When set, every revert path must stay inside this root after symlink resolution. */
  containmentRoot: Type.Optional(Type.String()),
  expected: ReadonlyArraySchema(
    Type.Object({
      path: Type.String(),
      afterHash: Type.String(),
      /**
       * Hash this path holds once the revert has completed, when the caller can
       * derive it. Supplying it lets a retry after a revert whose bookkeeping
       * failed recognise its own finished work instead of reporting a conflict.
       */
      revertedHash: Type.Optional(Type.String()),
    })
  ),
  operations: ReadonlyArraySchema(
    Type.Union([
      Type.Object({
        type: Type.Literal('create'),
        path: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('restore'),
        path: Type.String(),
        contentBase64: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('move'),
        path: Type.String(),
        movedTo: Type.String(),
        contentBase64: Type.String(),
      }),
    ])
  ),
});
export type RuntimeSnapshotRevertParams = Static<typeof RuntimeSnapshotRevertParamsSchema>;

export const RuntimeSnapshotRevertResultSchema = Type.Object({
  revertedFiles: Type.Number(),
});
export type RuntimeSnapshotRevertResult = Static<typeof RuntimeSnapshotRevertResultSchema>;
