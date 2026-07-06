import type { ProviderType, ReasoningEffort } from '@mangostudio/shared';
import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type { ToolIntent } from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import type { AIProvider, ToolDefinition } from '../../../services/providers/types';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import { GENERATE_IMAGE_TOOL_NAME } from '../../../services/tools/builtin/generate-image';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { appendSkillsPromptSection } from '../../skills/application/skills-prompt-section';
import { shouldExposeDelegateTool } from './delegate-tool-availability';
import {
  type ResolvedAgentRuntime,
  resolveAgentRuntime,
  resolveRuntimeAgentId,
} from './resolve-agent-runtime';
import { type ResolvedModel, resolveModel } from './resolve-model';
import { assertTextTurnHasContent, normalizeTextTurnAttachmentIds } from './text-turn-content';

export interface TurnContextInput {
  chatId: string;
  userId: string;
  prompt: string;
  attachmentIds?: string[];
  model?: string;
  systemPrompt?: string;
  promptSettings?: PromptSettings;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxToolIterations?: number;
  contextSettings?: ContextSettings;
  toolIntent?: ToolIntent;
  agentMode?: AgentExecutionMode;
  agentId?: AgentId;
  resolvedAgentProfile?: AgentProfile;
  signal?: AbortSignal;
  resolvedModel?: ResolvedModel;
}

export interface TurnContext {
  chatId: string;
  userId: string;
  prompt: string;
  attachmentIds: string[];
  interactionMode: 'chat' | 'agent';
  resolvedModel: ResolvedModel;
  provider: AIProvider;
  agentRuntime: ResolvedAgentRuntime;
  multiAgentSettings: MultiAgentSettings;
  toolDefinitions: ToolDefinition[];
  allowedToolNames: Set<string>;
  delegateToolAvailable: boolean;
  effectiveSystemPrompt: string | undefined;
}

export async function resolveTurnContext(
  input: TurnContextInput,
  db: Kysely<Database>
): Promise<TurnContext> {
  await assertChatOwnership(input.chatId, input.userId, db);
  const attachmentIds = normalizeTextTurnAttachmentIds(input.attachmentIds);
  assertTextTurnHasContent(input.prompt, attachmentIds);

  const requestedAgentId = resolveRuntimeAgentId(input.agentMode, input.agentId);
  const resolvedAgentProfile =
    input.resolvedAgentProfile ?? (await getAgentProfile(db, input.userId, requestedAgentId));
  const resolvedModel =
    input.resolvedModel ??
    (await resolveModel({
      requestedModel: input.model ?? resolvedAgentProfile.model,
      userId: input.userId,
      type: 'text',
    }));

  const { modelId, providerType } = resolvedModel;
  const interactionMode = input.agentMode === 'agent' ? 'agent' : 'chat';

  const provider = providerType
    ? getProvider(providerType)
    : await getProviderForModel(modelId, input.userId);

  const [agentRuntime, appSettings] = await Promise.all([
    resolveAgentRuntime({
      db,
      userId: input.userId,
      agentMode: input.agentMode,
      agentId: input.agentId,
      provider: provider.providerType,
      requestRuntimeSettings: getRequestRuntimeSettings(provider.providerType, input),
      profile: resolvedAgentProfile,
    }),
    getAppSettings(db, input.userId),
  ]);

  const multiAgentSettings = appSettings.multiAgentSettings;
  const delegateToolAvailable = shouldExposeDelegateTool({
    interactionMode,
    profile: agentRuntime.profile,
    settings: multiAgentSettings,
  });

  const toolDefinitions = agentRuntime.toolDefinitions.filter(
    (tool) => tool.name !== DELEGATE_TO_AGENT_TOOL_NAME || delegateToolAvailable
  );
  const allowedToolNames = new Set(toolDefinitions.map((tool) => tool.name));

  let effectiveSystemPrompt = agentRuntime.effectiveSystemPrompt;
  if (
    provider.generateAgentTurnStream &&
    input.toolIntent === 'image_generation_requested' &&
    allowedToolNames.has(GENERATE_IMAGE_TOOL_NAME)
  ) {
    const hint =
      'The user explicitly clicked Create images for this turn. Use the image generation tool when appropriate.';
    effectiveSystemPrompt = effectiveSystemPrompt ? `${effectiveSystemPrompt}\n\n${hint}` : hint;
  }
  effectiveSystemPrompt = appendSkillsPromptSection(effectiveSystemPrompt, allowedToolNames);

  return {
    chatId: input.chatId,
    userId: input.userId,
    prompt: input.prompt,
    attachmentIds,
    interactionMode,
    resolvedModel,
    provider,
    agentRuntime,
    multiAgentSettings,
    toolDefinitions,
    allowedToolNames,
    delegateToolAvailable,
    effectiveSystemPrompt,
  };
}

function getRequestRuntimeSettings(
  provider: ProviderType,
  input: TurnContextInput
): Partial<ProviderRuntimeSettings> {
  return {
    provider,
    ...(input.thinkingEnabled !== undefined ? { thinkingEnabled: input.thinkingEnabled } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.maxToolIterations !== undefined
      ? { maxToolIterations: input.maxToolIterations }
      : {}),
    ...(input.contextSettings?.providerCompactionEnabled !== undefined
      ? { providerCompactionEnabled: input.contextSettings.providerCompactionEnabled }
      : {}),
  };
}
