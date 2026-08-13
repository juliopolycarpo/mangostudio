import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';

export const FileCheckpointOpSchema = Type.Union([
  Type.Literal('create'),
  Type.Literal('edit'),
  Type.Literal('delete'),
  Type.Literal('move'),
]);

export type FileCheckpointOp = Static<typeof FileCheckpointOpSchema>;

export const ChatFileCheckpointSummarySchema = Type.Object({
  messageId: Type.String(),
  fileCount: Type.Integer({ minimum: 0 }),
  ops: ReadonlyArraySchema(FileCheckpointOpSchema),
  createdAt: Type.Number(),
});

export type ChatFileCheckpointSummary = Static<typeof ChatFileCheckpointSummarySchema>;

export const ChatFileCheckpointsResponseSchema = Type.Object({
  checkpoints: ReadonlyArraySchema(ChatFileCheckpointSummarySchema),
});

export type ChatFileCheckpointsResponse = Static<typeof ChatFileCheckpointsResponseSchema>;

export const RevertChatFileCheckpointsResponseSchema = Type.Object({
  revertedFiles: Type.Integer({ minimum: 0 }),
});

export type RevertChatFileCheckpointsResponse = Static<
  typeof RevertChatFileCheckpointsResponseSchema
>;
