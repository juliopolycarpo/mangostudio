import Type, { type Static } from 'typebox';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '../agentic-limits';
import { AgentIdSchema } from '../agents/schemas';
import { ContextSettingsSchema } from '../chat/schemas';
import { ExternalAgentTargetIdSchema } from '../external-agents/schemas';
import { schemaMaxLengthFor } from '../external-agents/vendor-text';
import { PromptSettingsSchema } from '../prompt-rules/schemas';
import { ProviderTypeSchema, ReasoningEffortSchema } from '../provider-settings/schemas';
import { ResumeInterruptedTurnSchema } from '../turn-recovery/schemas';

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
/** Matches `vendorId` in `EXTERNAL_TEXT_LIMITS`, doubled for UTF-16 units. */
const EXTERNAL_VENDOR_ID_MAX_LENGTH = schemaMaxLengthFor('vendorId');

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

/**
 * What only an external turn carries.
 *
 * Both ids are the vendor's own, not MangoStudio's: a Codex model id and one of
 * that model's `supportedReasoningEfforts` entries. They cannot ride on `model`
 * and `reasoningEffort`, because `reasoningEffort` is a closed MangoStudio enum
 * and a vendor's effort vocabulary is whatever that vendor's catalog said. A
 * separate object is also what keeps an internal turn from ever reading them.
 *
 * The permission axes are deliberately absent — they are persisted on the chat,
 * so a send cannot quietly widen what the agent may do.
 */
export const ExternalTurnRequestSchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1, maxLength: EXTERNAL_VENDOR_ID_MAX_LENGTH })),
  effort: Type.Optional(Type.String({ minLength: 1, maxLength: EXTERNAL_VENDOR_ID_MAX_LENGTH })),
});

export type ExternalTurnRequest = Static<typeof ExternalTurnRequestSchema>;

export const RespondStreamBodySchema = Type.Object({
  chatId: ChatIdSchema,
  externalTurn: Type.Optional(ExternalTurnRequestSchema),
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
  agentId: Type.Optional(AgentIdSchema),
  recovery: Type.Optional(ResumeInterruptedTurnSchema),
});

export type RespondStreamBody = Static<typeof RespondStreamBodySchema>;

/**
 * Why a `generated_image` part settled into `error` without ever reaching the
 * provider.
 *
 * A closed code rather than the persisted `error` string, because that string
 * also travels as the tool result a model reads — it stays in English on
 * purpose — while the code is what a renderer switches on to show the user's
 * own language instead of replaying it verbatim.
 */
export const ImageGenerationErrorCodeSchema = Type.Literal('image_generation_interrupted');

export type ImageGenerationErrorCode = Static<typeof ImageGenerationErrorCodeSchema>;

/**
 * Why a turn could not resolve a model.
 *
 * A closed vocabulary rather than the server's sentence, because the two arms
 * lead somewhere different: `not-configured` is answered in Settings, and
 * `provider-deprecated` is answered by moving the work to the vendor's own CLI.
 * A client that only had prose would have to pattern-match English to tell them
 * apart.
 */
export const ModelUnavailableReasonSchema = Type.Union([
  Type.Literal('not-configured'),
  Type.Literal('provider-deprecated'),
]);

export type ModelUnavailableReason = Static<typeof ModelUnavailableReasonSchema>;

/**
 * What the client can offer to do about it.
 *
 * `fork-with-external-runner` is D14: a chat with MangoStudio-owned turns
 * cannot become vendor-owned in place, so the offer is a new chat carrying
 * environment and workdir, never an edit of this one.
 */
export const ModelUnavailableActionSchema = Type.Union([
  Type.Literal('configure-connector'),
  Type.Literal('fork-with-external-runner'),
]);

export type ModelUnavailableAction = Static<typeof ModelUnavailableActionSchema>;

/**
 * The refusal, as it travels on `ApiErrorResponse.details`.
 *
 * Every field is a string because `details` is a string map on the wire, and
 * widening that for one refusal would change the shape of every error response.
 * The reason and the action are what the client renders; `modelId` and
 * `provider` are what let it name the thing that stopped working.
 */
export const ModelUnavailableDetailsSchema = Type.Object({
  reason: ModelUnavailableReasonSchema,
  action: ModelUnavailableActionSchema,
  /** The stored model id the turn tried to run, when the request named one. */
  modelId: Type.Optional(Type.String({ maxLength: GENERATION_MODEL_ID_MAX_LENGTH })),
  provider: Type.Optional(ProviderTypeSchema),
  /** The external agent `fork-with-external-runner` should point the fork at. */
  targetId: Type.Optional(ExternalAgentTargetIdSchema),
});

export type ModelUnavailableDetails = Static<typeof ModelUnavailableDetailsSchema>;
