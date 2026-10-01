import Type, { type Static, type TSchema } from 'typebox';
import type { MessagePart } from '../types/agent-events';
import {
  ChatAttachmentSchema,
  GeneratedImageArtifactSchema,
  InteractionModeSchema,
} from './schemas';

/**
 * One stored message part, as the transcript sends it.
 *
 * Deliberately permissive: a part is any object with a string `type`, which is
 * all the reader checks before serving it (`decodeMessageParts`). Older releases
 * wrote part shapes the frontend's normaliser still reads, and a part with an
 * unrecognised `type` is kept rather than dropped, so describing each variant
 * here would make valid history fail response validation. The derived type is
 * the {@link MessagePart} union the renderers narrow on.
 */
export const MessagePartSchema = Type.Unsafe<MessagePart>(
  Type.Object({ type: Type.String() }, { additionalProperties: true })
);

/**
 * A nullable optional column, exactly as the transcript sends it: a stored row
 * carries `null` where the column is empty, and the wire has always been the
 * stored row. Remapping `null` to absent would change every existing client's
 * bytes, so the schema admits both instead.
 */
const NullableOptional = <T extends TSchema>(schema: T) =>
  Type.Optional(Type.Union([schema, Type.Null()]));

/**
 * A chat message as the API sends it, one row of the transcript.
 *
 * Source of truth for {@link Message}. `imageUrl`, `referenceImage`,
 * `generationTime`, `modelName` and `providerState` are `null` when the stored
 * column is empty; `styleParams`, `parts`, `generatedImages` and `attachments`
 * are omitted when there is nothing to send. `agentId` and `agentName` are set
 * only on messages built in the client.
 *
 * Key order is part of the contract. The response is serialised in schema
 * order, and the bytes clients have always received are the `messages` column
 * order, then the joined `generatedImages` and `attachments`. Reordering a key
 * here reorders it on the wire; `chat-transcript-wire.integration.test.ts`
 * pins the text. A column added to `messages` must be added here too, or the
 * response drops it.
 */
export const MessageSchema = Type.Object({
  id: Type.String(),
  chatId: Type.String(),
  role: Type.Union([Type.Literal('user'), Type.Literal('ai')]),
  text: Type.String(),
  imageUrl: NullableOptional(Type.String()),
  referenceImage: NullableOptional(Type.String()),
  timestamp: Type.Number(),
  isGenerating: Type.Optional(Type.Boolean()),
  generationTime: NullableOptional(Type.String()),
  modelName: NullableOptional(Type.String()),
  styleParams: Type.Optional(Type.Array(Type.String())),
  interactionMode: Type.Optional(InteractionModeSchema),
  parts: Type.Optional(Type.Array(MessagePartSchema)),
  providerState: NullableOptional(Type.String()),
  generatedImages: Type.Optional(Type.Array(GeneratedImageArtifactSchema)),
  attachments: Type.Optional(Type.Array(ChatAttachmentSchema)),
  agentId: Type.Optional(Type.String()),
  agentName: Type.Optional(Type.String()),
});

export type Message = Static<typeof MessageSchema>;
