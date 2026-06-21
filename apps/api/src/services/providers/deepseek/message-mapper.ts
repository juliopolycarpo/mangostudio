import type OpenAI from 'openai';
import { appendAttachmentFallbackNotes } from '../core/attachment-content';
import { buildChatCompletionsReplay } from '../core/replay-builder';
import { toolDefsToChatCompletions } from '../core/tool-mapper';
import type {
  ChatTurnContext,
  ModelCapabilities,
  ProviderRuntimeAttachment,
  ToolDefinition,
} from '../types';
import { normalizeDeepSeekReasoningEffort } from './normalizers';

export interface DeepSeekTurnLoopState {
  provider: 'deepseek';
  loopMessages: unknown[];
}

export function buildDeepSeekAgentMessages(params: {
  systemPrompt?: string;
  history: ChatTurnContext[];
  loopMessages?: unknown[];
  toolResults?: Array<{ callId: string; name: string; result: string; isError?: boolean }>;
  prompt?: string;
  attachments?: ProviderRuntimeAttachment[];
  modelCapabilities?: ModelCapabilities;
}): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  if (params.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }

  messages.push(...buildChatCompletionsReplay(params.history));

  if (params.loopMessages) {
    messages.push(...(params.loopMessages as OpenAI.ChatCompletionMessageParam[]));
  }

  if (params.toolResults && params.toolResults.length > 0) {
    for (const tr of params.toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.callId,
        content: tr.result,
      });
    }
  } else {
    const providerPrompt = buildDeepSeekProviderPrompt(params);
    if (providerPrompt !== undefined) {
      messages.push({ role: 'user', content: providerPrompt });
    }
  }

  return messages;
}

export function buildDeepSeekProviderPrompt(params: {
  prompt?: string;
  attachments?: ProviderRuntimeAttachment[];
  modelCapabilities?: ModelCapabilities;
}): string | undefined {
  if (params.prompt === undefined && (params.attachments?.length ?? 0) === 0) return undefined;
  return appendAttachmentFallbackNotes(
    params.prompt ?? '',
    params.attachments,
    params.modelCapabilities
  );
}

export function buildDeepSeekTools(
  defs?: ToolDefinition[]
): OpenAI.ChatCompletionTool[] | undefined {
  if (!defs || defs.length === 0) return undefined;
  return toolDefsToChatCompletions(defs);
}

export function buildDeepSeekRequestBody(params: {
  modelName: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  thinkingEnabled: boolean;
  reasoningEffort?: string;
  signal?: AbortSignal;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.modelName,
    messages: params.messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }

  if (params.thinkingEnabled) {
    body.thinking = { type: 'enabled' };
    const effort = params.reasoningEffort
      ? normalizeDeepSeekReasoningEffort(params.reasoningEffort as never)
      : undefined;
    if (effort) {
      body.reasoning_effort = effort;
    }
  }

  return body;
}
