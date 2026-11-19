import Type, { type Static } from 'typebox';

import { ReadonlyArraySchema } from '../schema-helpers';

export const FileCheckpointOpSchema = Type.Union([
  Type.Literal('create'),
  Type.Literal('edit'),
  Type.Literal('delete'),
  Type.Literal('move'),
]);

export type FileCheckpointOp = Static<typeof FileCheckpointOpSchema>;

/**
 * A class of tool a turn ran whose filesystem writes no checkpoint describes.
 *
 * `shell` hands the write to a child process and `mcp` to a foreign server, so
 * neither has a path list to snapshot before the fact. Recording which of them
 * ran is what lets revert say what it did *not* undo instead of reporting a
 * bare file count as a whole-turn undo.
 *
 * `mcp` means "an MCP tool ran", not "an MCP tool wrote": the hub cannot know
 * whether a given foreign tool touches the filesystem, so the copy this drives
 * says *may have*.
 */
export const UncheckpointedWriteSourceSchema = Type.Union([
  Type.Literal('shell'),
  Type.Literal('mcp'),
]);

export type UncheckpointedWriteSource = Static<typeof UncheckpointedWriteSourceSchema>;

/** Stable order for the wire and the UI copy, independent of execution order. */
export const UNCHECKPOINTED_WRITE_SOURCES = ['shell', 'mcp'] as const satisfies ReadonlyArray<
  Static<typeof UncheckpointedWriteSourceSchema>
>;

export const ChatFileCheckpointSummarySchema = Type.Object({
  messageId: Type.String(),
  fileCount: Type.Integer({ minimum: 0 }),
  ops: ReadonlyArraySchema(FileCheckpointOpSchema),
  /** Empty when every write this turn made was checkpointed. */
  uncheckpointedSources: ReadonlyArraySchema(UncheckpointedWriteSourceSchema),
  /**
   * True when at least one row came from a shell workspace capture
   * (`checkpointWorkspaceWrites`) rather than from a builtin mutator's own
   * before-state. Such rows are found by comparing the tree before and after the
   * command, so a revert can also undo a change another process made meanwhile;
   * the confirmation says so only for these turns.
   */
  includesShellCapture: Type.Boolean(),
  createdAt: Type.Number(),
});

export type ChatFileCheckpointSummary = Static<typeof ChatFileCheckpointSummarySchema>;

export const ChatFileCheckpointsResponseSchema = Type.Object({
  checkpoints: ReadonlyArraySchema(ChatFileCheckpointSummarySchema),
});

export type ChatFileCheckpointsResponse = Static<typeof ChatFileCheckpointsResponseSchema>;

export const RevertChatFileCheckpointsResponseSchema = Type.Object({
  revertedFiles: Type.Integer({ minimum: 0 }),
  /**
   * What the revert did not undo. Reported alongside the count so the result
   * surface can restate the boundary instead of presenting the count as the
   * whole turn.
   */
  uncheckpointedSources: ReadonlyArraySchema(UncheckpointedWriteSourceSchema),
});

export type RevertChatFileCheckpointsResponse = Static<
  typeof RevertChatFileCheckpointsResponseSchema
>;
