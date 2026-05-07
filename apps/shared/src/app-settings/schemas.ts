import { Type, type Static } from '@sinclair/typebox';
import { ContextSettingsSchema } from '../chat';
import { PromptSettingsSchema } from '../prompt-rules';
import { ReasoningEffortSchema } from '../provider-settings';

export const ImageQualitySchema = Type.Union([
  Type.Literal('512px'),
  Type.Literal('1K'),
  Type.Literal('2K'),
  Type.Literal('4K'),
]);

export const AppSettingsSchema = Type.Object({
  promptSettings: PromptSettingsSchema,
  globalImageQuality: ImageQualitySchema,
  thinkingEnabled: Type.Boolean(),
  reasoningEffort: ReasoningEffortSchema,
  maxToolIterations: Type.Integer({ minimum: 1, maximum: 25 }),
  contextSettings: ContextSettingsSchema,
});

export type ImageQuality = Static<typeof ImageQualitySchema>;
export type AppSettings = Static<typeof AppSettingsSchema>;
