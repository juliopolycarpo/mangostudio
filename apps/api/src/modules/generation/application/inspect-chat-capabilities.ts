/**
 * Read-only capability inspection for a chat: projects the exact runtime the
 * turn pipeline would resolve for the same chat/model/agent selection into
 * the shared `ChatCapabilitiesResponse` contract. Eligibility rules are never
 * duplicated here — tool candidates come from `resolveAgentRuntime` and the
 * delegate gate from `shouldExposeDelegateTool`, the same functions a real
 * turn uses. Resolving that runtime performs the turn pipeline's own cached
 * MCP tool listing, which connects lazily — inspecting a chat can therefore
 * spawn an enabled server on a cache miss, exactly as the first turn would.
 * Health itself is read passively (last-known status, no extra probe).
 */

import type { AgentExecutionMode, AgentId } from '@mangostudio/shared/agents';
import type {
  CapabilityMcpServerEntry,
  CapabilitySkillEntry,
  CapabilityState,
  CapabilityToolEntry,
  ChatCapabilitiesResponse,
} from '@mangostudio/shared/capabilities';
import type { SkillDescriptor } from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database, McpServerSelect } from '../../../db/types';
import { getMcpRuntimeStatus } from '../../../services/mcp/connection-manager';
import type { McpBridgeServerSnapshot } from '../../../services/mcp/tool-bridge';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { extractContextInfo } from '../../chats/application/list-chats';
import { getOwnedChatOrThrow } from '../../chats/domain/chat-ownership';
import { getById } from '../../chats/infrastructure/chat-repository';
import { listMcpServerRows } from '../../mcp-servers/infrastructure/mcp-server-repository';
import { listSkills } from '../../skills/application/skill-discovery';
import { SKILL_TOOL_NAME } from '../../skills/domain/skill';
import { shouldExposeDelegateTool } from './delegate-tool-availability';
import { resolveEnvironmentDisplayName } from './environment-display-name';
import { resolveAgentRuntime, resolveRuntimeAgentId } from './resolve-agent-runtime';
import type { ToolCapabilityCandidate } from './resolve-capability-candidates';
import { resolveModel } from './resolve-model';

export interface InspectChatCapabilitiesInput {
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly chatId: string;
  /** Composer overrides — the same selection inputs a turn would send. */
  readonly model?: string;
  readonly agentMode?: AgentExecutionMode;
  readonly agentId?: AgentId;
}

/**
 * Builds the capability projection for one chat. Ownership is verified before
 * anything else resolves. // Usage: const capabilities = await inspectChatCapabilities({ db, userId, chatId })
 */
export async function inspectChatCapabilities(
  input: InspectChatCapabilitiesInput
): Promise<ChatCapabilitiesResponse> {
  const ownedChat = await getOwnedChatOrThrow(input.chatId, input.userId, input.db);

  const requestedAgentId = resolveRuntimeAgentId(input.agentMode, input.agentId);
  const profile = await getAgentProfile(input.db, input.userId, requestedAgentId);
  const resolvedModel = await resolveModel({
    requestedModel: input.model ?? profile.model,
    userId: input.userId,
    type: 'text',
  });
  const provider = resolvedModel.providerType
    ? getProvider(resolvedModel.providerType)
    : await getProviderForModel(resolvedModel.modelId, input.userId);
  const [runtimeClient, environmentName] = await Promise.all([
    getRuntimeClient(input.userId, ownedChat.environmentId),
    resolveEnvironmentDisplayName(input.userId, ownedChat.environmentId),
  ]);

  const [chat, agentRuntime, appSettings, serverRows, skills] = await Promise.all([
    getById(input.chatId, input.db),
    resolveAgentRuntime({
      db: input.db,
      userId: input.userId,
      agentMode: input.agentMode,
      agentId: input.agentId,
      provider: provider.providerType,
      profile,
      runtimeManifest: runtimeClient.manifest,
      environmentId: ownedChat.environmentId,
      environmentName,
    }),
    getAppSettings(input.db, input.userId),
    listMcpServerRows(input.db, input.userId),
    listSkills(input.db, input.userId),
  ]);

  const interactionMode = input.agentMode === 'agent' ? 'agent' : 'chat';
  const delegateToolAvailable = shouldExposeDelegateTool({
    interactionMode,
    profile: agentRuntime.profile,
    settings: appSettings.multiAgentSettings,
  });

  const tools = agentRuntime.toolCandidates.map((candidate) =>
    toToolEntry(candidate, delegateToolAvailable)
  );
  const enabledToolNames = new Set(
    tools.filter((tool) => tool.state === 'enabled').map((tool) => tool.name)
  );

  const snapshotsBySlug = new Map(
    agentRuntime.mcpServerSnapshots.map((snapshot) => [snapshot.slug, snapshot])
  );
  const mcpServers = serverRows.map((row) =>
    toMcpServerEntry({
      row,
      snapshot: snapshotsBySlug.get(row.slug),
      userId: input.userId,
      toolsEnabled: profile.toolsEnabled,
      enabledToolNames,
      environmentName,
    })
  );

  const skillEntries = skills.map((skill) =>
    toSkillEntry(skill, enabledToolNames.has(SKILL_TOOL_NAME))
  );

  return {
    chatId: input.chatId,
    model: {
      modelId: resolvedModel.modelId,
      provider: provider.providerType,
    },
    agent: {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      mode: interactionMode,
    },
    tools,
    mcpServers,
    skills: skillEntries,
    counts: {
      effectiveTools: enabledToolNames.size,
      effectiveSkills: skillEntries.filter((skill) => skill.state === 'enabled').length,
    },
    contextInfo: extractContextInfo(chat?.lastContextState, chat?.lastProviderState),
    // Profile/provider-derived settings only: composer-level runtime overrides
    // are not hashed. Thread requestRuntimeSettings through the query contract
    // before using this value as a staleness signal.
    runtimeHash: agentRuntime.runtimeHash,
  };
}

/**
 * The exact tool names a turn with this selection would hand the provider.
 * Exposed for the parity test that pins the inspector to the turn pipeline.
 */
export function effectiveToolNames(response: ChatCapabilitiesResponse): string[] {
  return response.tools.filter((tool) => tool.state === 'enabled').map((tool) => tool.name);
}

function toToolEntry(
  candidate: ToolCapabilityCandidate,
  delegateToolAvailable: boolean
): CapabilityToolEntry {
  const base = {
    name: candidate.name,
    title: candidate.title,
    source: candidate.source,
    ...(candidate.category ? { category: candidate.category } : {}),
    ...(candidate.serverSlug ? { serverSlug: candidate.serverSlug } : {}),
    ...(candidate.serverName ? { serverName: candidate.serverName } : {}),
    ...(candidate.environmentName ? { environmentName: candidate.environmentName } : {}),
  };

  // Mirror resolveTurnContext: an effective delegate tool is still withheld
  // from the provider when multi-agent settings gate delegation off.
  if (
    candidate.definition &&
    candidate.name === DELEGATE_TO_AGENT_TOOL_NAME &&
    !delegateToolAvailable
  ) {
    return { ...base, state: 'unavailable', reason: 'delegation-disabled' };
  }
  if (candidate.definition) return { ...base, state: 'enabled' };
  return {
    ...base,
    state: candidateState(candidate.reason),
    ...(candidate.reason ? { reason: candidate.reason } : {}),
  };
}

export function candidateState(reason: ToolCapabilityCandidate['reason']): CapabilityState {
  return reason === 'tool-setting-disabled' ||
    reason === 'agent-tools-disabled' ||
    reason === 'agent-allowlist'
    ? 'disabled'
    : 'unavailable';
}

interface McpServerEntryInput {
  readonly row: McpServerSelect;
  readonly snapshot: McpBridgeServerSnapshot | undefined;
  readonly userId: string;
  readonly toolsEnabled: boolean;
  readonly enabledToolNames: ReadonlySet<string>;
  /** Display name of the chat's environment; attached to runtime-denied. */
  readonly environmentName: string;
}

function toMcpServerEntry(input: McpServerEntryInput): CapabilityMcpServerEntry {
  const { row, snapshot } = input;
  const base = {
    slug: row.slug,
    name: row.name,
    effectiveToolCount: snapshot
      ? snapshot.tools.filter((tool) => input.enabledToolNames.has(tool.name)).length
      : 0,
  };

  if (row.enabled === 0) {
    return { ...base, state: 'disabled', reason: 'server-disabled', health: 'disabled' };
  }

  // Last-known status: reading it adds no probe of its own, and the runtime
  // listing above has already settled. Raw transport error text is never
  // surfaced — only the status code.
  const health = getMcpRuntimeStatus(input.userId, row.id).status;
  if (!input.toolsEnabled) {
    return { ...base, state: 'disabled', reason: 'agent-tools-disabled', health };
  }
  // Checked before `listed`: the machine's refusal is why no listing was
  // attempted, and naming it beats reporting a connection that never ran.
  if (snapshot?.runtimeDenied) {
    return {
      ...base,
      state: 'unavailable',
      reason: 'runtime-denied',
      health,
      environmentName: input.environmentName,
    };
  }
  if (!snapshot?.listed) {
    return { ...base, state: 'unavailable', reason: 'server-unavailable', health };
  }
  return { ...base, state: 'enabled', health };
}

function toSkillEntry(skill: SkillDescriptor, skillToolEnabled: boolean): CapabilitySkillEntry {
  const base = {
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    source: skill.source,
  };

  if (!skill.valid) return { ...base, state: 'unavailable', reason: 'skill-invalid' };
  if (skill.shadowed) return { ...base, state: 'unavailable', reason: 'skill-shadowed' };
  if (!skill.enabled) return { ...base, state: 'disabled', reason: 'skill-disabled' };
  if (!skillToolEnabled) return { ...base, state: 'unavailable', reason: 'skill-tool-disabled' };
  return { ...base, state: 'enabled' };
}
