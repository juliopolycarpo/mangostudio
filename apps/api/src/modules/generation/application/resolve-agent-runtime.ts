import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import type { ProviderType } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  listDeniedMcpBridgeServers,
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

export function resolveRuntimeAgentId(agentId: AgentId | undefined): AgentId {
  return agentId ?? 'default';
}

export async function resolveAgentRuntime(
  input: ResolveAgentRuntimeInput
): Promise<ResolvedAgentRuntime> {
  const requestedAgentId = resolveRuntimeAgentId(input.agentId);
  const profile =
    input.profile ?? (await getAgentProfile(input.db, input.userId, requestedAgentId));
  const [savedProviderSettings, toolSettings, mcpServerSnapshots] = await Promise.all([
    getProviderSettings(input.db, input.userId, input.provider),
    listSavedToolSettings(input.db, input.userId),
    listTurnMcpServers(input, profile),
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
    environmentId: input.environmentId,
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

/**
 * The turn's MCP snapshots. A machine that refuses MCP is snapshotted without
 * connecting: every `mcp.connect` would come back `RUNTIME_DENIED`, so the
 * listing can only cost the per-server budget. The rows still travel so the
 * inspector can attribute the refusal to the machine.
 */
function listTurnMcpServers(
  input: ResolveAgentRuntimeInput,
  profile: AgentProfile
): Promise<McpBridgeServerSnapshot[]> | McpBridgeServerSnapshot[] {
  if (!profile.toolsEnabled) return [];
  const scope = { environmentId: input.environmentId };
  if (input.runtimeManifest.features.mcp === false) {
    return listDeniedMcpBridgeServers(input.db, input.userId, scope);
  }
  return listMcpBridgeServers(input.db, input.userId, scope);
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
