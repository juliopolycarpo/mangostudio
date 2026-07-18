import { type Static, Type } from '@sinclair/typebox';
import { AgentExecutionModeSchema, AgentIdSchema, AgentKindSchema } from '../agents/schemas';
import { ContextInfoSchema } from '../chat/schemas';
import { McpServerStatusSchema } from '../mcp/schemas';
import { SkillSourceSchema } from '../skills/schemas';
import { ToolSettingsCategorySchema } from '../tool-settings/schemas';

/**
 * Effective availability of one capability for the active chat:
 * - `enabled` — part of the exact set handed to the provider this turn;
 * - `disabled` — turned off by a user/agent setting and re-enablable there;
 * - `unavailable` — filtered by a runtime rule (provider limit, health,
 *   precedence) that no single toggle flips back on.
 */
export const CapabilityStateSchema = Type.Union([
  Type.Literal('enabled'),
  Type.Literal('disabled'),
  Type.Literal('unavailable'),
]);

/**
 * Typed, actionable reason a capability is not enabled. The frontend maps
 * each code to a translated explanation and a settings deep-link; free-text
 * reasons never cross the contract.
 */
export const CapabilityReasonCodeSchema = Type.Union([
  /** The agent profile disables tool use entirely. */
  Type.Literal('agent-tools-disabled'),
  /** The agent profile's tool allowlist does not admit this name. */
  Type.Literal('agent-allowlist'),
  /** The user disabled this tool in tool settings. */
  Type.Literal('tool-setting-disabled'),
  /** The namespaced MCP name exceeds the provider tool-name cap. */
  Type.Literal('name-over-provider-limit'),
  /** The owning MCP server is toggled off. */
  Type.Literal('server-disabled'),
  /** The owning MCP server failed to connect or list tools in budget. */
  Type.Literal('server-unavailable'),
  /** Delegation is gated off by multi-agent settings or the agent profile. */
  Type.Literal('delegation-disabled'),
  /** The skill directory failed validation. */
  Type.Literal('skill-invalid'),
  /** The user disabled this skill in skill settings. */
  Type.Literal('skill-disabled'),
  /** A higher-precedence source owns this skill slug. */
  Type.Literal('skill-shadowed'),
  /** The `skill` tool itself is not effective for this turn. */
  Type.Literal('skill-tool-disabled'),
]);

export const CapabilityToolSourceSchema = Type.Union([
  Type.Literal('builtin'),
  Type.Literal('mcp'),
]);

/**
 * One tool in the normalized presentation model shared by builtins and MCP.
 * Deliberately excludes parameter schemas, command lines, and any runtime
 * error text — the inspector is a read-only projection, not a debug dump.
 */
export const CapabilityToolEntrySchema = Type.Object({
  /** Normalized name as sent to the provider (`mcp__<slug>__<tool>` for MCP). */
  name: Type.String({ minLength: 1 }),
  /** Display title: builtin settings title, or the raw MCP tool name. */
  title: Type.String({ minLength: 1 }),
  source: CapabilityToolSourceSchema,
  state: CapabilityStateSchema,
  reason: Type.Optional(CapabilityReasonCodeSchema),
  /** Settings category — builtin tools only. */
  category: Type.Optional(ToolSettingsCategorySchema),
  /** Owning server provenance — MCP tools only. */
  serverSlug: Type.Optional(Type.String({ minLength: 1 })),
  serverName: Type.Optional(Type.String({ minLength: 1 })),
});

/** Last-known (passive) server health; never triggers a connect or probe. */
export const CapabilityMcpServerHealthSchema = Type.Union([
  McpServerStatusSchema,
  Type.Literal('disabled'),
]);

export const CapabilityMcpServerEntrySchema = Type.Object({
  slug: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  state: CapabilityStateSchema,
  reason: Type.Optional(CapabilityReasonCodeSchema),
  health: CapabilityMcpServerHealthSchema,
  /** How many of this server's tools are effective for the turn. */
  effectiveToolCount: Type.Integer({ minimum: 0 }),
});

export const CapabilitySkillEntrySchema = Type.Object({
  /** Stable identity: `<source>:<slug>`. */
  key: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  source: SkillSourceSchema,
  state: CapabilityStateSchema,
  reason: Type.Optional(CapabilityReasonCodeSchema),
});

/** Composer overrides accepted by the inspector — the same selection inputs a turn uses. */
export const ChatCapabilitiesQuerySchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1 })),
  agentMode: Type.Optional(AgentExecutionModeSchema),
  agentId: Type.Optional(AgentIdSchema),
});

export const ChatCapabilitiesResponseSchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  model: Type.Object({
    modelId: Type.String({ minLength: 1 }),
    provider: Type.Optional(Type.String({ minLength: 1 })),
  }),
  agent: Type.Object({
    id: AgentIdSchema,
    name: Type.String({ minLength: 1 }),
    kind: AgentKindSchema,
    mode: AgentExecutionModeSchema,
  }),
  tools: Type.Array(CapabilityToolEntrySchema),
  mcpServers: Type.Array(CapabilityMcpServerEntrySchema),
  skills: Type.Array(CapabilitySkillEntrySchema),
  counts: Type.Object({
    /** Exactly the number of tool definitions handed to the provider. */
    effectiveTools: Type.Integer({ minimum: 0 }),
    effectiveSkills: Type.Integer({ minimum: 0 }),
  }),
  /** Persisted continuation/context snapshot for the chat, when one exists. */
  contextInfo: Type.Union([ContextInfoSchema, Type.Null()]),
  /**
   * Hash of profile/provider-derived runtime settings and the effective tool
   * set. Composer-level runtime overrides are not hashed; thread
   * `requestRuntimeSettings` through the query contract before using this as
   * a staleness signal.
   */
  runtimeHash: Type.String({ minLength: 1 }),
});

export type CapabilityState = Static<typeof CapabilityStateSchema>;
export type CapabilityReasonCode = Static<typeof CapabilityReasonCodeSchema>;
export type CapabilityToolSource = Static<typeof CapabilityToolSourceSchema>;
export type CapabilityToolEntry = Static<typeof CapabilityToolEntrySchema>;
export type CapabilityMcpServerHealth = Static<typeof CapabilityMcpServerHealthSchema>;
export type CapabilityMcpServerEntry = Static<typeof CapabilityMcpServerEntrySchema>;
export type CapabilitySkillEntry = Static<typeof CapabilitySkillEntrySchema>;
export type ChatCapabilitiesQuery = Static<typeof ChatCapabilitiesQuerySchema>;
export type ChatCapabilitiesResponse = Static<typeof ChatCapabilitiesResponseSchema>;
