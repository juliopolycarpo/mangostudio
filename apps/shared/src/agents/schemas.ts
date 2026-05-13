import { Type, type Static } from '@sinclair/typebox';
import { ReasoningEffortSchema } from '../provider-settings';

export const BuiltInAgentIdSchema = Type.Union([Type.Literal('chat'), Type.Literal('default')]);

export const UserAgentIdSchema = Type.String({ pattern: '^user:[a-z0-9]+(?:-[a-z0-9]+)*$' });

export const AgentIdSchema = Type.Union([BuiltInAgentIdSchema, UserAgentIdSchema]);

export const AgentExecutionModeSchema = Type.Union([Type.Literal('chat'), Type.Literal('agent')]);

export const AgentKindSchema = Type.Union([Type.Literal('builtin'), Type.Literal('user')]);

export const AgentRoleSchema = Type.Union([
  Type.Literal('primary'),
  Type.Literal('subagent'),
  Type.Literal('both'),
]);

export const AgentSourceSchema = Type.Union([
  Type.Object({ type: Type.Literal('builtin') }),
  Type.Object({
    type: Type.Literal('markdown'),
    path: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);

export const AgentMetadataSchema = Type.Record(Type.String(), Type.Unknown());

export const AgentProfileSchema = Type.Object({
  id: AgentIdSchema,
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  kind: AgentKindSchema,
  role: AgentRoleSchema,
  source: AgentSourceSchema,
  systemPrompt: Type.String(),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  maxToolIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  toolNames: Type.Array(Type.String({ minLength: 1 })),
  toolsEnabled: Type.Boolean(),
  subagentIds: Type.Array(AgentIdSchema),
  metadata: AgentMetadataSchema,
});

export const AgentProfileListResponseSchema = Type.Object({
  agents: Type.Array(AgentProfileSchema),
});

export const AgentProfileUpsertBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  role: AgentRoleSchema,
  systemPrompt: Type.String(),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  maxToolIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  toolNames: Type.Array(Type.String({ minLength: 1 })),
  toolsEnabled: Type.Boolean(),
  subagentIds: Type.Array(AgentIdSchema),
  metadata: AgentMetadataSchema,
});

export const CreateAgentProfileBodySchema = Type.Intersect([
  AgentProfileUpsertBodySchema,
  Type.Object({ slug: Type.Optional(Type.String({ minLength: 1 })) }),
]);

export const AgentMarkdownPreviewBodySchema = Type.Object({
  markdown: Type.String(),
  id: Type.Optional(UserAgentIdSchema),
});

export const AgentMarkdownPreviewResponseSchema = Type.Object({
  profile: AgentProfileSchema,
  markdown: Type.String(),
});

export const DeleteAgentProfileResponseSchema = Type.Object({
  success: Type.Literal(true),
});

export type BuiltInAgentId = Static<typeof BuiltInAgentIdSchema>;
export type UserAgentId = Static<typeof UserAgentIdSchema>;
export type AgentId = Static<typeof AgentIdSchema>;
export type AgentExecutionMode = Static<typeof AgentExecutionModeSchema>;
export type AgentKind = Static<typeof AgentKindSchema>;
export type AgentRole = Static<typeof AgentRoleSchema>;
export type AgentSource = Static<typeof AgentSourceSchema>;
export type AgentProfile = Static<typeof AgentProfileSchema>;
export type AgentProfileListResponse = Static<typeof AgentProfileListResponseSchema>;
export type AgentProfileUpsertBody = Static<typeof AgentProfileUpsertBodySchema>;
export type CreateAgentProfileBody = Static<typeof CreateAgentProfileBodySchema>;
export type AgentMarkdownPreviewBody = Static<typeof AgentMarkdownPreviewBodySchema>;
export type AgentMarkdownPreviewResponse = Static<typeof AgentMarkdownPreviewResponseSchema>;
export type DeleteAgentProfileResponse = Static<typeof DeleteAgentProfileResponseSchema>;
