import { Type, type Static } from '@sinclair/typebox';

const InteractionModeSchema = Type.Union([Type.Literal('chat'), Type.Literal('image')]);

export const CreateChatBodySchema = Type.Object({
  title: Type.String(),
  model: Type.Optional(Type.String()),
});

export type CreateChatBody = Static<typeof CreateChatBodySchema>;

export const UpdateChatBodySchema = Type.Object({
  title: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  textModel: Type.Optional(Type.String()),
  imageModel: Type.Optional(Type.String()),
  lastUsedMode: Type.Optional(InteractionModeSchema),
});

export type UpdateChatBody = Static<typeof UpdateChatBodySchema>;

export const CreateMessageBodySchema = Type.Object({
  id: Type.String(),
  chatId: Type.String(),
  role: Type.Union([Type.Literal('user'), Type.Literal('ai')]),
  text: Type.String(),
  imageUrl: Type.Optional(Type.String()),
  referenceImage: Type.Optional(Type.String()),
  timestamp: Type.Number(),
  isGenerating: Type.Optional(Type.Boolean()),
  generationTime: Type.Optional(Type.String()),
  modelName: Type.Optional(Type.String()),
  styleParams: Type.Optional(Type.Array(Type.String())),
  interactionMode: Type.Optional(InteractionModeSchema),
});

export type CreateMessageBody = Static<typeof CreateMessageBodySchema>;

export const UpdateMessageBodySchema = Type.Object({
  text: Type.Optional(Type.String()),
  imageUrl: Type.Optional(Type.String()),
  isGenerating: Type.Optional(Type.Boolean()),
  generationTime: Type.Optional(Type.String()),
  modelName: Type.Optional(Type.String()),
  styleParams: Type.Optional(Type.Array(Type.String())),
});

export type UpdateMessageBody = Static<typeof UpdateMessageBodySchema>;
