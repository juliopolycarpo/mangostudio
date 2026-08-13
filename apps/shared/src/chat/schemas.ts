import Type, { type Static } from 'typebox';
import { AgentIdSchema } from '../agents/schemas';
import {
  ExternalAgentTargetIdSchema,
  ExternalApprovalRoutingSchema,
  ExternalPermissionLevelSchema,
} from '../external-agents/schemas';

const InteractionModeSchema = Type.Union([
  Type.Literal('chat'),
  Type.Literal('agent'),
  Type.Literal('image'),
]);

/**
 * Re-exported from its own bounded context so the runner union keeps reading in
 * one place. `external-agents` owns the definition; nothing about *which*
 * external agents exist belongs to the chat contract.
 */
export {
  type ExternalAgentTargetId,
  ExternalAgentTargetIdSchema,
} from '../external-agents/schemas';

/**
 * Who runs a chat's turns. Deliberately excludes anything the server owns —
 * the vendor's native session handle, runtime session, canonical workspace,
 * vendor account, and effective settings live in a separate server-owned
 * table that no client request can write.
 */
export const ChatRunnerConfigurationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('mangostudio'), agentId: AgentIdSchema }),
  Type.Object({ kind: Type.Literal('external'), targetId: ExternalAgentTargetIdSchema }),
]);

export type ChatRunnerConfiguration = Static<typeof ChatRunnerConfigurationSchema>;

/**
 * The permission choice a chat carries into every external turn.
 *
 * Kept out of {@link ChatRunnerConfigurationSchema} because the two answer
 * different questions and change on different schedules: the runner is who runs
 * the turn, this is what that runner may do. A MangoStudio chat simply never
 * sets it — MangoStudio's own tool permissions are settings, not a per-chat pair.
 *
 * Both axes are optional. Absent means "not chosen yet", which the server
 * resolves to the restrictive end of each axis rather than to a vendor default;
 * writing one in on chat creation would make an unmade choice indistinguishable
 * from a deliberate one.
 */
export const ChatRunnerPermissionsSchema = Type.Object({
  level: Type.Optional(ExternalPermissionLevelSchema),
  routing: Type.Optional(ExternalApprovalRoutingSchema),
});

export type ChatRunnerPermissions = Static<typeof ChatRunnerPermissionsSchema>;

export const ChatAttachmentKindSchema = Type.Union([
  Type.Literal('image'),
  Type.Literal('text'),
  Type.Literal('pdf'),
  Type.Literal('data'),
  Type.Literal('unknown'),
]);

export type ChatAttachmentKind = Static<typeof ChatAttachmentKindSchema>;
const ContextModeSchema = Type.Union([
  Type.Literal('stateful'),
  Type.Literal('stateless-loop'),
  Type.Literal('replay'),
  Type.Literal('compacted'),
  Type.Literal('degraded'),
]);
const ContextSeveritySchema = Type.Union([
  Type.Literal('normal'),
  Type.Literal('info'),
  Type.Literal('warning'),
  Type.Literal('danger'),
  Type.Literal('critical'),
]);

export const ContextCompactionBehaviorSchema = Type.Union([
  Type.Literal('ask'),
  Type.Literal('auto_compact_current_chat'),
  Type.Literal('continue_with_summary_new_chat'),
  Type.Literal('off'),
]);

export type ContextCompactionBehavior = Static<typeof ContextCompactionBehaviorSchema>;

export const ContextInfoSchema = Type.Object({
  estimatedInputTokens: Type.Number(),
  contextLimit: Type.Number(),
  estimatedUsageRatio: Type.Number(),
  mode: ContextModeSchema,
  severity: ContextSeveritySchema,
});

export type ContextInfo = Static<typeof ContextInfoSchema>;

export const ChatSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  model: Type.Union([Type.String(), Type.Null()]),
  textModel: Type.Union([Type.String(), Type.Null()]),
  imageModel: Type.Union([Type.String(), Type.Null()]),
  runner: ChatRunnerConfigurationSchema,
  runnerPermissions: ChatRunnerPermissionsSchema,
  workdir: Type.Union([Type.String(), Type.Null()]),
  environmentId: Type.String({ minLength: 1 }),
  restrictToolsToWorkdir: Type.Union([Type.Boolean(), Type.Null()]),
  contextInfo: Type.Optional(Type.Union([ContextInfoSchema, Type.Null()])),
});

export const ChatListSchema = Type.Array(ChatSchema);

export type Chat = Static<typeof ChatSchema>;

export const ContextSettingsSchema = Type.Object({
  compactionBehavior: ContextCompactionBehaviorSchema,
  warningThreshold: Type.Number({ minimum: 0.5, maximum: 0.99 }),
  dangerThreshold: Type.Number({ minimum: 0.5, maximum: 0.99 }),
  hardStopThreshold: Type.Number({ minimum: 0.5, maximum: 0.99 }),
  preferredSummaryModel: Type.String(),
  providerCompactionEnabled: Type.Boolean(),
});

export type ContextSettings = Static<typeof ContextSettingsSchema>;

export const ChatAttachmentSchema = Type.Object({
  id: Type.String(),
  chatId: Type.String(),
  messageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  originalName: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Number(),
  kind: ChatAttachmentKindSchema,
  url: Type.String(),
  createdAt: Type.Number(),
});

export type ChatAttachment = Static<typeof ChatAttachmentSchema>;

export const UploadChatAttachmentResponseSchema = Type.Object({
  attachment: ChatAttachmentSchema,
});

export type UploadChatAttachmentResponse = Static<typeof UploadChatAttachmentResponseSchema>;

export const CreateChatBodySchema = Type.Object({
  title: Type.String(),
  model: Type.Optional(Type.String()),
});

export type CreateChatBody = Static<typeof CreateChatBodySchema>;

export const GenerateChatTitleBodySchema = Type.Object({
  prompt: Type.String(),
  model: Type.String(),
});

export type GenerateChatTitleBody = Static<typeof GenerateChatTitleBodySchema>;

export const GenerateChatTitleResponseSchema = Type.Object({
  title: Type.String(),
});

export type GenerateChatTitleResponse = Static<typeof GenerateChatTitleResponseSchema>;

export const UpdateChatBodySchema = Type.Object({
  title: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  textModel: Type.Optional(Type.String()),
  imageModel: Type.Optional(Type.String()),
  runner: Type.Optional(ChatRunnerConfigurationSchema),
  runnerPermissions: Type.Optional(ChatRunnerPermissionsSchema),
  workdir: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  environmentId: Type.Optional(Type.String({ minLength: 1 })),
  restrictToolsToWorkdir: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

export type UpdateChatBody = Static<typeof UpdateChatBodySchema>;

export const CompactChatBodySchema = Type.Object({
  model: Type.Optional(Type.String()),
});

export type CompactChatBody = Static<typeof CompactChatBodySchema>;

export const SummarizeToNewChatBodySchema = Type.Object({
  model: Type.Optional(Type.String()),
});

export type SummarizeToNewChatBody = Static<typeof SummarizeToNewChatBodySchema>;

export const ContextCompactionResponseSchema = Type.Object({
  chatId: Type.String(),
  summaryMessageId: Type.String(),
  contextInfo: Type.Union([ContextInfoSchema, Type.Null()]),
});

export type ContextCompactionResponse = Static<typeof ContextCompactionResponseSchema>;

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
