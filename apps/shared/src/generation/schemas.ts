import { type Static, Type } from '@sinclair/typebox';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '../agentic-limits';
import { AgentExecutionModeSchema, AgentIdSchema } from '../agents/schemas';
import { ContextSettingsSchema } from '../chat/schemas';
import { PromptSettingsSchema } from '../prompt-rules/schemas';
import { ReasoningEffortSchema } from '../provider-settings/schemas';

export const ToolIntentSchema = Type.Optional(
  Type.Union([Type.Literal('image_generation_requested')])
);

export type ToolIntent = Static<typeof ToolIntentSchema>;

export const GenerateImageBodySchema = Type.Object({
  chatId: Type.String(),
  prompt: Type.String(),
  systemPrompt: Type.Optional(Type.String()),
  promptSettings: Type.Optional(PromptSettingsSchema),
  referenceImageUrl: Type.Optional(Type.String()),
  imageQuality: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

export type GenerateImageBody = Static<typeof GenerateImageBodySchema>;

export const GenerateTextBodySchema = Type.Object({
  chatId: Type.String(),
  prompt: Type.String(),
  attachmentIds: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.String()),
});

export type GenerateTextBody = Static<typeof GenerateTextBodySchema>;

export const RespondStreamBodySchema = Type.Object({
  chatId: Type.String(),
  prompt: Type.String(),
  attachmentIds: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.String()),
  promptSettings: Type.Optional(PromptSettingsSchema),
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  thinkingVisibility: Type.Optional(Type.String()),
  maxToolIterations: Type.Optional(
    Type.Integer({ minimum: MAX_TOOL_ITERATIONS_MIN, maximum: MAX_TOOL_ITERATIONS_MAX })
  ),
  contextSettings: Type.Optional(ContextSettingsSchema),
  toolIntent: ToolIntentSchema,
  agentMode: Type.Optional(AgentExecutionModeSchema),
  agentId: Type.Optional(AgentIdSchema),
});

export type RespondStreamBody = Static<typeof RespondStreamBodySchema>;
