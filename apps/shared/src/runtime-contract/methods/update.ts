/**
 * The runtime-binary update method family: one bounded transfer opened,
 * chunked, and committed across three calls.
 *
 * Schema-first, like its siblings — the schema is the source and the type is
 * `Static<>` of it. `RuntimeUpdateBeginParams.sourceSha` is the one field in
 * this family where absent and `null` are different values on purpose; see
 * its docblock below.
 */

import Type, { type Static } from 'typebox';

/** Opens one bounded runtime-binary transfer. Bytes travel in sequential calls. */
export const RuntimeUpdateBeginParamsSchema = Type.Object({
  version: Type.String(),
  digest: Type.String(),
  totalBytes: Type.Number(),
  /**
   * Source commit these bytes were built from, when the sender has one; `null`
   * or absent where the version already names the build, which is every release
   * this hub installs from today.
   *
   * The absent case is not "leave what is recorded alone": the slot config is
   * written by merge, so an update that omitted this left the *previous*
   * commit next to the new binary. Stale provenance reads as confident and
   * wrong, where missing provenance at least reads as missing — so a slot's
   * recorded commit is replaced or cleared by every update, never inherited.
   */
  sourceSha: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type RuntimeUpdateBeginParams = Static<typeof RuntimeUpdateBeginParamsSchema>;

export const RuntimeUpdateBeginResultSchema = Type.Object({
  sessionId: Type.String(),
  maxChunkBytes: Type.Number(),
});
export type RuntimeUpdateBeginResult = Static<typeof RuntimeUpdateBeginResultSchema>;

export const RuntimeUpdateChunkParamsSchema = Type.Object({
  sessionId: Type.String(),
  seq: Type.Number(),
  bytesBase64: Type.String(),
});
export type RuntimeUpdateChunkParams = Static<typeof RuntimeUpdateChunkParamsSchema>;

export const RuntimeUpdateChunkResultSchema = Type.Object({
  acceptedBytes: Type.Number(),
  receivedBytes: Type.Number(),
});
export type RuntimeUpdateChunkResult = Static<typeof RuntimeUpdateChunkResultSchema>;

export const RuntimeUpdateCommitParamsSchema = Type.Object({
  sessionId: Type.String(),
});
export type RuntimeUpdateCommitParams = Static<typeof RuntimeUpdateCommitParamsSchema>;

export const RuntimeUpdateCommitResultSchema = Type.Object({
  version: Type.String(),
  digest: Type.String(),
  /** Manual means the new bytes are current but this process keeps serving the old inode. */
  restart: Type.Union([Type.Literal('scheduled'), Type.Literal('manual')]),
});
export type RuntimeUpdateCommitResult = Static<typeof RuntimeUpdateCommitResultSchema>;
