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
import { SNAPSHOT_CHUNK_MAX_BYTES } from '../limits';
import { RuntimeAckResultSchema, RuntimeSnapshotMaxBytesSchema } from './common';

/** Base64 length of {@link SNAPSHOT_CHUNK_MAX_BYTES} bytes, padding included. */
const SNAPSHOT_CHUNK_MAX_BASE64_LENGTH = Math.ceil(SNAPSHOT_CHUNK_MAX_BYTES / 3) * 4;

export const RuntimeSnapshotCaptureParamsSchema = Type.Object({
  path: Type.String(),
  snapshotMaxBytes: Type.Optional(RuntimeSnapshotMaxBytesSchema),
});
export type RuntimeSnapshotCaptureParams = Static<typeof RuntimeSnapshotCaptureParamsSchema>;

/** Identifies a snapshot staged on the runtime: the capture names it, an upload chooses it. */
const RuntimeStagedIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  // The runtime enforces the alphabet itself: an id becomes a file name there.
  description: 'Staged snapshot id, 1 to 64 characters from [A-Za-z0-9_-].',
});

export const RuntimeSnapshotReadChunkParamsSchema = Type.Object({
  stagedId: RuntimeStagedIdSchema,
  offset: Type.Integer({ minimum: 0 }),
  length: Type.Integer({ minimum: 1, maximum: SNAPSHOT_CHUNK_MAX_BYTES }),
});
export type RuntimeSnapshotReadChunkParams = Static<typeof RuntimeSnapshotReadChunkParamsSchema>;

export const RuntimeSnapshotReadChunkResultSchema = Type.Object({
  /** Empty once `offset` reaches the end of the staged snapshot. */
  contentBase64: Type.String(),
});
export type RuntimeSnapshotReadChunkResult = Static<typeof RuntimeSnapshotReadChunkResultSchema>;

export const RuntimeSnapshotStageChunkParamsSchema = Type.Object({
  /** The caller picks the id; the first chunk (offset 0) creates the staged snapshot. */
  stagedId: RuntimeStagedIdSchema,
  /** Must equal the bytes staged so far, so a lost or repeated chunk is refused. */
  offset: Type.Integer({ minimum: 0 }),
  contentBase64: Type.String({ maxLength: SNAPSHOT_CHUNK_MAX_BASE64_LENGTH }),
});
export type RuntimeSnapshotStageChunkParams = Static<typeof RuntimeSnapshotStageChunkParamsSchema>;

export const RuntimeSnapshotStageChunkResultSchema = Type.Object({
  stagedBytes: Type.Integer({ minimum: 0 }),
});
export type RuntimeSnapshotStageChunkResult = Static<typeof RuntimeSnapshotStageChunkResultSchema>;

export const RuntimeSnapshotReleaseParamsSchema = Type.Object({
  stagedId: RuntimeStagedIdSchema,
});
export type RuntimeSnapshotReleaseParams = Static<typeof RuntimeSnapshotReleaseParamsSchema>;

export const RuntimeSnapshotReleaseResultSchema = RuntimeAckResultSchema;
export type RuntimeSnapshotReleaseResult = Static<typeof RuntimeSnapshotReleaseResultSchema>;

export const RuntimeSnapshotHashParamsSchema = Type.Object({
  path: Type.String(),
});
export type RuntimeSnapshotHashParams = Static<typeof RuntimeSnapshotHashParamsSchema>;

export const RuntimeSnapshotHashResultSchema = Type.Object({
  hash: Type.Union([Type.String(), Type.Null()]),
});
export type RuntimeSnapshotHashResult = Static<typeof RuntimeSnapshotHashResultSchema>;

/**
 * Where a restored file's bytes come from: `contentBase64` for a small file, or
 * `stagedId` plus `hash` for one the caller uploaded with `snapshot.stage-chunk`.
 * Exactly one source is required; the runtime refuses an operation with both or
 * neither before it changes anything. `hash` is the SHA-256 the staged bytes
 * must have, checked before the first operation runs.
 */
const RuntimeRestoreContentFields = {
  contentBase64: Type.Optional(Type.String()),
  stagedId: Type.Optional(RuntimeStagedIdSchema),
  hash: Type.Optional(Type.String()),
};

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
        ...RuntimeRestoreContentFields,
      }),
      Type.Object({
        type: Type.Literal('move'),
        path: Type.String(),
        movedTo: Type.String(),
        ...RuntimeRestoreContentFields,
      }),
    ])
  ),
});
export type RuntimeSnapshotRevertParams = Static<typeof RuntimeSnapshotRevertParamsSchema>;

export const RuntimeSnapshotRevertResultSchema = Type.Object({
  revertedFiles: Type.Number(),
});
export type RuntimeSnapshotRevertResult = Static<typeof RuntimeSnapshotRevertResultSchema>;
