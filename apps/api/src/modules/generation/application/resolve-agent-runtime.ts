import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { ProviderType } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listMcpToolDefinitions } from '../../../services/mcp/tool-bridge';
import { toolNameMatches } from '../../../services/mcp/tool-naming';
import { mergeProviderRuntimeSettings } from '../../../services/providers/core/provider-settings-policy';
import type { ToolDefinition } from '../../../services/providers/types';
import { getToolDefinitionsForAgent } from '../../../services/tools';
import type { EffectiveToolSettings } from '../../../services/tools/types';
import { computeHash } from '../../../utils/hash';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { getProviderSettings } from '../../provider-settings/infrastructure/provider-settings-repository';
import { listSavedToolSettings } from '../../tool-settings/infrastructure/tool-settings-repository';

export interface AgentRuntimeSourceMetadata {
  readonly agentId: AgentId;
  readonly source: AgentProfile['source'];
  readonly kind: AgentProfile['kind'];
}

export interface ResolvedAgentRuntime {
  readonly profile: AgentProfile;
  readonly effectiveSystemPrompt: string | undefined;
  readonly toolDefinitions: ReadonlyArray<ToolDefinition>;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly toolSettingsByName: ReadonlyMap<string, EffectiveToolSettings>;
  readonly runtimeSettings: ProviderRuntimeSettings;
  readonly sourceMetadata: AgentRuntimeSourceMetadata;
  readonly runtimeHash: string;
}

export interface ResolveAgentRuntimeInput {
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly agentMode?: AgentExecutionMode;
  readonly agentId?: AgentId;
  readonly provider: ProviderType;
  readonly requestRuntimeSettings?: Partial<ProviderRuntimeSettings>;
  readonly profile?: AgentProfile;
}

export function resolveRuntimeAgentId(
  agentMode: AgentExecutionMode | undefined,
  agentId: AgentId | undefined
): AgentId {
  if (agentMode === 'agent') return agentId ?? 'default';
  return 'chat';
}

export async function resolveAgentRuntime(
  input: ResolveAgentRuntimeInput
): Promise<ResolvedAgentRuntime> {
  const requestedAgentId = resolveRuntimeAgentId(input.agentMode, input.agentId);
  const profile =
    input.profile ?? (await getAgentProfile(input.db, input.userId, requestedAgentId));
  const [savedProviderSettings, toolSettings, mcpToolDefinitions] = await Promise.all([
    getProviderSettings(input.db, input.userId, input.provider),
    listSavedToolSettings(input.db, input.userId),
    profile.toolsEnabled ? listMcpToolDefinitions(input.db, input.userId) : [],
  ]);
  const runtimeSettings = mergeProviderRuntimeSettings(input.provider, savedProviderSettings, {
    ...input.requestRuntimeSettings,
    ...getAgentRuntimeSettings(profile),
  });
  const toolDefinitions = [
    ...getToolDefinitionsForAgent(profile, toolSettings),
    ...filterMcpToolDefinitions(mcpToolDefinitions, profile, toolSettings),
  ];
  const allowedToolNames = new Set(toolDefinitions.map((definition) => definition.name));
  const effectiveSystemPrompt = profile.systemPrompt.trim() || undefined;
  const runtimeHash = computeAgentRuntimeHash({ profile, runtimeSettings, toolDefinitions });

  return {
    profile,
    effectiveSystemPrompt,
    toolDefinitions,
    allowedToolNames,
    toolSettingsByName: toolSettings,
    runtimeSettings,
    sourceMetadata: {
      agentId: profile.id,
      source: profile.source,
      kind: profile.kind,
    },
    runtimeHash,
  };
}

/**
 * MCP definitions honor the same gates as builtins: the agent allowlist
 * (exact name, `'*'`, or the per-server `mcp__<slug>__*` wildcard) and the
 * user's per-tool toggle — a disabled tool never reaches the provider.
 */
function filterMcpToolDefinitions(
  definitions: ReadonlyArray<ToolDefinition>,
  profile: AgentProfile,
  toolSettings: ReadonlyMap<string, EffectiveToolSettings>
): ToolDefinition[] {
  const allowlist = new Set(profile.toolNames);
  return definitions.filter(
    (definition) =>
      toolNameMatches(allowlist, definition.name) &&
      (toolSettings.get(definition.name)?.enabled ?? true)
  );
}

function getAgentRuntimeSettings(profile: AgentProfile): Partial<ProviderRuntimeSettings> {
  return {
    ...(profile.thinkingEnabled !== undefined ? { thinkingEnabled: profile.thinkingEnabled } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.maxToolIterations !== undefined
      ? { maxToolIterations: profile.maxToolIterations }
      : {}),
  };
}

function computeAgentRuntimeHash(input: {
  readonly profile: AgentProfile;
  readonly runtimeSettings: ProviderRuntimeSettings;
  readonly toolDefinitions: ReadonlyArray<ToolDefinition>;
}): string {
  return computeHash(
    JSON.stringify({
      agentId: input.profile.id,
      source: input.profile.source,
      systemPrompt: input.profile.systemPrompt,
      toolsEnabled: input.profile.toolsEnabled,
      toolNames: [...input.profile.toolNames].sort(),
      runtimeSettings: input.runtimeSettings,
      toolDefinitions: input.toolDefinitions.map((tool) => tool.name).sort(),
    })
  );
}
