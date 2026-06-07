import type OpenAI from 'openai';
import { parseJsonWith } from '../../../lib/safe-parse';
import {
  type ChatCompletionsDelta,
  createChatCompletionsAccumulator,
} from '../core/chat-completions-accumulator';
import { getModelContextLimit } from '../core/context-policy';
import { createContinuationEnvelope } from '../core/continuation-envelope';
import { extractReasoningChunks } from '../openai/normalizers';
import type { AgentEvent, AgentTurnRequest } from '../types';
import {
  buildDeepSeekMessages,
  buildDeepSeekProviderPrompt,
  buildDeepSeekRequestBody,
  type DeepSeekTurNLoopState,
} from './message-mapper';

export function parseDeepSeekLoopState(
  providerState: string | null | undefined
): DeepSeekTurNLoopState | null {
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider !== 'deepseek' || !Array.isArray(parsed.loopMessages)) return null;
    return parsed as unknown as DeepSeekTurNLoopState;
  });
}

export async function* streamDeepSeekAgentTurn(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncIterable<AgentEvent> {
  const loopState = parseDeepSeekLoopState(req.providerState);
  const thinkingEnabled = req.generationConfig?.thinkingEnabled ?? false;
  const reasoningEffort = req.generationConfig?.reasoningEffort;
  const providerPrompt = buildDeepSeekProviderPrompt(req);

  const messages = buildDeepSeekMessages({
    systemPrompt: req.systemPrompt,
    history: req.history,
    loopMessages: loopState?.loopMessages,
    toolResults: req.toolResults,
    prompt: req.prompt,
    attachments: req.attachments,
    modelCapabilities: req.modelCapabilities,
  });

  const tools =
    req.toolDefinitions && req.toolDefinitions.length > 0
      ? req.toolDefinitions.map((def) => ({
          type: 'function' as const,
          function: { name: def.name, description: def.description, parameters: def.parameters },
        }))
      : undefined;

  const body = buildDeepSeekRequestBody({
    modelName: req.modelName,
    messages,
    tools,
    thinkingEnabled,
    reasoningEffort,
    signal: req.signal,
  });

  try {
    let providerReportedInputTokens: number | undefined;
    let promptCacheHitTokens: number | undefined;
    let promptCacheMissTokens: number | undefined;

    const stream = await client.chat.completions.create(
      body as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: req.signal }
    );

    const accumulator = createChatCompletionsAccumulator({ extractReasoningChunks });

    for await (const chunk of stream) {
      if (req.signal?.aborted) return;

      const rawChunk = chunk as unknown as Record<string, unknown>;
      const usage = rawChunk.usage as
        | {
            prompt_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
          }
        | undefined;
      if (usage) {
        if (typeof usage.prompt_tokens === 'number') {
          providerReportedInputTokens = usage.prompt_tokens;
        }
        if (typeof usage.prompt_cache_hit_tokens === 'number') {
          promptCacheHitTokens = usage.prompt_cache_hit_tokens;
        }
        if (typeof usage.prompt_cache_miss_tokens === 'number') {
          promptCacheMissTokens = usage.prompt_cache_miss_tokens;
        }
      }

      const choice = chunk.choices[0];
      // choices array is empty on usage-only chunks
      if (!choice) continue;

      const delta = choice.delta as ChatCompletionsDelta;
      for (const event of accumulator.addDelta(delta)) {
        yield event;
      }

      if (choice.finish_reason) {
        for (const event of accumulator.finishToolCalls()) {
          yield event;
        }
      }
    }

    if (req.signal?.aborted) return;

    const assistantMsg = accumulator.buildAssistantMessage();

    const newLoopMessages: unknown[] = [
      ...(loopState?.loopMessages ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? req.toolResults.map((tr) => ({
            role: 'tool',
            tool_call_id: tr.callId,
            content: tr.result,
          }))
        : providerPrompt !== undefined
          ? [{ role: 'user', content: providerPrompt }]
          : []),
      assistantMsg,
    ];

    const context: { providerReportedInputTokens?: number; contextLimit?: number } = {};
    if (providerReportedInputTokens !== undefined) {
      context.providerReportedInputTokens = providerReportedInputTokens;
    }
    context.contextLimit = getModelContextLimit(req.modelName);

    const envelope = createContinuationEnvelope(
      'deepseek',
      'stateless-loop',
      req,
      undefined,
      context
    );

    const providerState: Record<string, unknown> = {
      ...envelope,
      loopMessages: newLoopMessages,
    };

    if (promptCacheHitTokens !== undefined) {
      providerState.promptCacheHitTokens = promptCacheHitTokens;
    }
    if (promptCacheMissTokens !== undefined) {
      providerState.promptCacheMissTokens = promptCacheMissTokens;
    }

    yield {
      type: 'turn_completed',
      providerState: JSON.stringify(providerState),
    };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'DeepSeek request failed',
    };
  }
}
