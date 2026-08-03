import type { ProviderType, ReasoningEffort } from '@mangostudio/shared';
import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
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
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import { GENERATE_IMAGE_TOOL_NAME } from '../../../services/tools/builtin/generate-image';
import type { WorkdirPolicy } from '../../../services/tools/types';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { getOwnedChatOrThrow } from '../../chats/domain/chat-ownership';
import { appendSkillsPromptSection } from '../../skills/application/skills-prompt-section';
import { appendTodosPromptSection } from '../../todos/application/todos-prompt-section';
import {
  buildWorkdirPolicy,
  resolveEffectiveRestrictToolsToWorkdir,
} from '../../workspaces/application/workdir-policy';
import { appendWorkdirPromptSection } from '../../workspaces/application/workdir-prompt-section';
import { shouldExposeDelegateTool } from './delegate-tool-availability';
import { resolveEnvironmentDisplayName } from './environment-display-name';
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
  environmentId: string;
  prompt: string;
  attachmentIds: string[];
  interactionMode: 'chat' | 'agent';
  workdir: string | undefined;
  workdirPolicy: WorkdirPolicy | undefined;
  resolvedModel: ResolvedModel;
  provider: AIProvider;
  agentRuntime: ResolvedAgentRuntime;
  multiAgentSettings: MultiAgentSettings;
  toolDefinitions: ToolDefinition[];
  allowedToolNames: Set<string>;
  delegateToolAvailable: boolean;
  effectiveSystemPrompt: string | undefined;
  /**
   * The system prompt before the per-turn todo section is appended. Used for
   * the continuation hash: the todo list changes nearly every turn during
   * agent work, and hashing it would degrade stateful continuation to replay.
   */
  continuationSystemPrompt: string | undefined;
}

export async function resolveTurnContext(
  input: TurnContextInput,
  db: Kysely<Database>
): Promise<TurnContext> {
  const chat = await getOwnedChatOrThrow(input.chatId, input.userId, db);
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
  const workdir = interactionMode === 'agent' ? (chat.workdir ?? undefined) : undefined;

  const provider = providerType
    ? getProvider(providerType)
    : await getProviderForModel(modelId, input.userId);
  const [runtimeClient, environmentName] = await Promise.all([
    getRuntimeClient(input.userId, chat.environmentId),
    resolveEnvironmentDisplayName(input.userId, chat.environmentId),
  ]);

  const [agentRuntime, appSettings] = await Promise.all([
    resolveAgentRuntime({
      db,
      userId: input.userId,
      agentMode: input.agentMode,
      agentId: input.agentId,
      provider: provider.providerType,
      requestRuntimeSettings: getRequestRuntimeSettings(provider.providerType, input),
      profile: resolvedAgentProfile,
      runtimeManifest: runtimeClient.manifest,
      environmentId: chat.environmentId,
      environmentName,
    }),
    getAppSettings(db, input.userId),
  ]);

  const multiAgentSettings = appSettings.multiAgentSettings;
  const restrictToolsToWorkdir = resolveEffectiveRestrictToolsToWorkdir(
    appSettings.workspaceSettings?.restrictToolsToWorkdir ??
      DEFAULT_WORKSPACE_SETTINGS.restrictToolsToWorkdir,
    chat.restrictToolsToWorkdir
  );
  const workdirPolicy = buildWorkdirPolicy(workdir, restrictToolsToWorkdir);
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
  effectiveSystemPrompt = appendWorkdirPromptSection(
    effectiveSystemPrompt,
    workdir,
    Boolean(workdirPolicy?.restricted)
  );
  effectiveSystemPrompt = await appendSkillsPromptSection(
    db,
    input.userId,
    effectiveSystemPrompt,
    allowedToolNames
  );
  const continuationSystemPrompt = effectiveSystemPrompt;
  effectiveSystemPrompt = await appendTodosPromptSection(
    db,
    input.userId,
    input.chatId,
    effectiveSystemPrompt,
    allowedToolNames
  );

  return {
    chatId: input.chatId,
    userId: input.userId,
    environmentId: chat.environmentId,
    prompt: input.prompt,
    attachmentIds,
    interactionMode,
    workdir,
    workdirPolicy,
    resolvedModel,
    provider,
    agentRuntime,
    multiAgentSettings,
    toolDefinitions,
    allowedToolNames,
    delegateToolAvailable,
    effectiveSystemPrompt,
    continuationSystemPrompt,
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
