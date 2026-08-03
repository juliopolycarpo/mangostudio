import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import type { ProviderType } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  listMcpBridgeServers,
  type McpBridgeServerSnapshot,
} from '../../../services/mcp/tool-bridge';
import { mergeProviderRuntimeSettings } from '../../../services/providers/core/provider-settings-policy';
import type { ToolDefinition } from '../../../services/providers/types';
import { getAllTools } from '../../../services/tools';
import type { EffectiveToolSettings } from '../../../services/tools/types';
import { computeHash } from '../../../utils/hash';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { getProviderSettings } from '../../provider-settings/infrastructure/provider-settings-repository';
import { listSavedToolSettings } from '../../tool-settings/infrastructure/tool-settings-repository';
import {
  effectiveToolDefinitions,
  resolveToolCandidates,
  type ToolCapabilityCandidate,
} from './resolve-capability-candidates';

interface AgentRuntimeSourceMetadata {
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
  /** Every considered tool with its rejection reason — the inspector's input. */
  readonly toolCandidates: ReadonlyArray<ToolCapabilityCandidate>;
  /** Per-server MCP resolution outcome (enabled servers only). */
  readonly mcpServerSnapshots: ReadonlyArray<McpBridgeServerSnapshot>;
}

export interface ResolveAgentRuntimeInput {
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly agentMode?: AgentExecutionMode;
  readonly agentId?: AgentId;
  readonly provider: ProviderType;
  readonly requestRuntimeSettings?: Partial<ProviderRuntimeSettings>;
  readonly profile?: AgentProfile;
  readonly runtimeManifest: RuntimeCapabilityManifest;
  /** The turn's environment; scopes which MCP servers can be offered. */
  readonly environmentId: string;
  /** Display name of the chat's environment; attached to runtime-denied. */
  readonly environmentName?: string;
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
  const [savedProviderSettings, toolSettings, mcpServerSnapshots] = await Promise.all([
    getProviderSettings(input.db, input.userId, input.provider),
    listSavedToolSettings(input.db, input.userId),
    profile.toolsEnabled
      ? listMcpBridgeServers(input.db, input.userId, { environmentId: input.environmentId })
      : [],
  ]);
  const runtimeSettings = mergeProviderRuntimeSettings(input.provider, savedProviderSettings, {
    ...input.requestRuntimeSettings,
    ...getAgentRuntimeSettings(profile),
  });
  const toolCandidates = resolveToolCandidates({
    profile,
    toolSettings,
    registeredTools: getAllTools(),
    mcpServers: mcpServerSnapshots,
    runtimeManifest: input.runtimeManifest,
    environmentName: input.environmentName,
  });
  const toolDefinitions = effectiveToolDefinitions(toolCandidates);
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
    toolCandidates,
    mcpServerSnapshots,
  };
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
