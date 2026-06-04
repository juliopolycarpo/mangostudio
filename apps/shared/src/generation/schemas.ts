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

export const GENERATION_CHAT_ID_MAX_LENGTH = 256;
export const GENERATION_PROMPT_MAX_LENGTH = 200_000;
export const GENERATION_SYSTEM_PROMPT_MAX_LENGTH = 50_000;
export const GENERATION_MODEL_ID_MAX_LENGTH = 256;
export const GENERATION_ATTACHMENT_IDS_MAX_ITEMS = 20;
export const GENERATION_ATTACHMENT_ID_MAX_LENGTH = 256;
export const GENERATION_REFERENCE_IMAGE_URL_MAX_LENGTH = 4_096;
export const GENERATION_IMAGE_QUALITY_MAX_LENGTH = 64;
export const GENERATION_THINKING_VISIBILITY_MAX_LENGTH = 32;

const ChatIdSchema = Type.String({ maxLength: GENERATION_CHAT_ID_MAX_LENGTH });
const PromptSchema = Type.String({ maxLength: GENERATION_PROMPT_MAX_LENGTH });
const SystemPromptSchema = Type.String({ maxLength: GENERATION_SYSTEM_PROMPT_MAX_LENGTH });
const ModelIdSchema = Type.String({ maxLength: GENERATION_MODEL_ID_MAX_LENGTH });
const AttachmentIdsSchema = Type.Array(
  Type.String({ maxLength: GENERATION_ATTACHMENT_ID_MAX_LENGTH }),
  { maxItems: GENERATION_ATTACHMENT_IDS_MAX_ITEMS }
);

export const GenerateImageBodySchema = Type.Object({
  chatId: ChatIdSchema,
  prompt: PromptSchema,
  systemPrompt: Type.Optional(SystemPromptSchema),
  promptSettings: Type.Optional(PromptSettingsSchema),
  referenceImageUrl: Type.Optional(
    Type.String({ maxLength: GENERATION_REFERENCE_IMAGE_URL_MAX_LENGTH })
  ),
  imageQuality: Type.Optional(Type.String({ maxLength: GENERATION_IMAGE_QUALITY_MAX_LENGTH })),
  model: Type.Optional(ModelIdSchema),
});

export type GenerateImageBody = Static<typeof GenerateImageBodySchema>;

export const GenerateTextBodySchema = Type.Object({
  chatId: ChatIdSchema,
  prompt: PromptSchema,
  attachmentIds: Type.Optional(AttachmentIdsSchema),
  model: Type.Optional(ModelIdSchema),
  systemPrompt: Type.Optional(SystemPromptSchema),
});

export type GenerateTextBody = Static<typeof GenerateTextBodySchema>;

export const RespondStreamBodySchema = Type.Object({
  chatId: ChatIdSchema,
  prompt: PromptSchema,
  attachmentIds: Type.Optional(AttachmentIdsSchema),
  model: Type.Optional(ModelIdSchema),
  systemPrompt: Type.Optional(SystemPromptSchema),
  promptSettings: Type.Optional(PromptSettingsSchema),
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  thinkingVisibility: Type.Optional(
    Type.String({ maxLength: GENERATION_THINKING_VISIBILITY_MAX_LENGTH })
  ),
  maxToolIterations: Type.Optional(
    Type.Integer({ minimum: MAX_TOOL_ITERATIONS_MIN, maximum: MAX_TOOL_ITERATIONS_MAX })
  ),
  contextSettings: Type.Optional(ContextSettingsSchema),
  toolIntent: ToolIntentSchema,
  agentMode: Type.Optional(AgentExecutionModeSchema),
  agentId: Type.Optional(AgentIdSchema),
});

export type RespondStreamBody = Static<typeof RespondStreamBodySchema>;
