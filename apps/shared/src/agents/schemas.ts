import Type, { type Static } from 'typebox';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '../agentic-limits';
import { ReasoningEffortSchema } from '../provider-settings';
import { ReadonlyArraySchema } from '../schema-helpers';

export const BuiltInAgentIdSchema = Type.Union([Type.Literal('default'), Type.Literal('explore')]);

/**
 * User agent ids are slugged `user:<slug>` strings. `Type.Unsafe` keeps the
 * strict runtime pattern while inferring the precise `user:${string}` template
 * type — without it the derived `AgentId` union would collapse to `string`.
 */
export const UserAgentIdSchema = Type.Unsafe<`user:${string}`>(
  Type.String({ pattern: '^user:[a-z0-9]+(?:-[a-z0-9]+)*$' })
);

export const AgentIdSchema = Type.Union([BuiltInAgentIdSchema, UserAgentIdSchema]);

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
  maxToolIterations: Type.Optional(
    Type.Integer({ minimum: MAX_TOOL_ITERATIONS_MIN, maximum: MAX_TOOL_ITERATIONS_MAX })
  ),
  toolNames: ReadonlyArraySchema(Type.String({ minLength: 1 })),
  toolsEnabled: Type.Boolean(),
  subagentIds: ReadonlyArraySchema(AgentIdSchema),
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
  maxToolIterations: Type.Optional(
    Type.Integer({ minimum: MAX_TOOL_ITERATIONS_MIN, maximum: MAX_TOOL_ITERATIONS_MAX })
  ),
  toolNames: ReadonlyArraySchema(Type.String({ minLength: 1 })),
  toolsEnabled: Type.Boolean(),
  subagentIds: ReadonlyArraySchema(AgentIdSchema),
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
export type AgentKind = Static<typeof AgentKindSchema>;
export type AgentRole = Static<typeof AgentRoleSchema>;
export type AgentSource = Static<typeof AgentSourceSchema>;
export type AgentMetadata = Readonly<Static<typeof AgentMetadataSchema>>;
export type AgentProfile = Static<typeof AgentProfileSchema>;
export type AgentProfileListResponse = Static<typeof AgentProfileListResponseSchema>;
export type AgentProfileUpsertBody = Static<typeof AgentProfileUpsertBodySchema>;
export type CreateAgentProfileBody = Static<typeof CreateAgentProfileBodySchema>;
export type AgentMarkdownPreviewBody = Static<typeof AgentMarkdownPreviewBodySchema>;
export type AgentMarkdownPreviewResponse = Static<typeof AgentMarkdownPreviewResponseSchema>;
export type DeleteAgentProfileResponse = Static<typeof DeleteAgentProfileResponseSchema>;
