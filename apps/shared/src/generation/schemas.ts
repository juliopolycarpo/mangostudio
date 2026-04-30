import { Type, type Static } from '@sinclair/typebox';
import { ContextSettingsSchema } from '../chat/schemas';

export const GenerateImageBodySchema = Type.Object({
  chatId: Type.String(),
  prompt: Type.String(),
  systemPrompt: Type.Optional(Type.String()),
  referenceImageUrl: Type.Optional(Type.String()),
  imageQuality: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

export type GenerateImageBody = Static<typeof GenerateImageBodySchema>;

export const GenerateTextBodySchema = Type.Object({
  chatId: Type.String(),
  prompt: Type.String(),
  model: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.String()),
});

export type GenerateTextBody = Static<typeof GenerateTextBodySchema>;

export const RespondStreamBodySchema = Type.Object({
  chatId: Type.String(),
  prompt: Type.String(),
  model: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.String()),
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(Type.String()),
  thinkingVisibility: Type.Optional(Type.String()),
  maxToolIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  contextSettings: Type.Optional(ContextSettingsSchema),
});

export type RespondStreamBody = Static<typeof RespondStreamBodySchema>;
