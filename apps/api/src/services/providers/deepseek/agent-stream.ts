import type OpenAI from 'openai';
import { createContinuationEnvelope } from '../core/continuation-envelope';
import { getModelContextLimit } from '../core/context-policy';
import { extractReasoningChunks } from '../openai/normalizers';
import type { AgentTurnRequest, AgentEvent } from '../types';
import { parseJsonWith } from '../../../lib/safe-parse';
import {
  buildDeepSeekMessages,
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

  const messages = buildDeepSeekMessages({
    systemPrompt: req.systemPrompt,
    history: req.history,
    loopMessages: loopState?.loopMessages,
    toolResults: req.toolResults,
    prompt: req.prompt,
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

    let assistantText = '';
    let assistantReasoning = '';
    const pendingToolCalls = new Map<number, { callId: string; name: string; argsStr: string }>();

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;

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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown>;

      for (const reasoningChunk of extractReasoningChunks(delta)) {
        assistantReasoning += reasoningChunk;
        yield { type: 'reasoning_delta', text: reasoningChunk };
      }

      if (typeof delta.content === 'string' && delta.content) {
        assistantText += delta.content;
        yield { type: 'assistant_text_delta', text: delta.content };
      }

      const toolCalls = delta.tool_calls as
        | Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
        | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tcDelta of toolCalls) {
          const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
          const fn = tcDelta.function;

          if (typeof tcDelta.id === 'string') {
            const callId = tcDelta.id;
            const name = typeof fn?.name === 'string' ? fn.name : '';
            const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
            pendingToolCalls.set(idx, { callId, name, argsStr: args });
            yield { type: 'tool_call_started', callId, name: name || undefined };
          } else {
            const tc = pendingToolCalls.get(idx);
            if (tc) {
              const argsDelta = typeof fn?.arguments === 'string' ? fn.arguments : '';
              tc.argsStr += argsDelta;
              if (argsDelta) {
                yield { type: 'tool_call_arguments_delta', callId: tc.callId, delta: argsDelta };
              }
            }
          }
        }
      }

      if (choice.finish_reason) {
        for (const tc of pendingToolCalls.values()) {
          yield {
            type: 'tool_call_completed',
            callId: tc.callId,
            name: tc.name,
            arguments: tc.argsStr,
          };
        }
      }
    }

    const assistantMsg: Record<string, unknown> =
      pendingToolCalls.size > 0
        ? {
            role: 'assistant',
            content: assistantText || null,
            tool_calls: Array.from(pendingToolCalls.values()).map((tc) => ({
              id: tc.callId,
              type: 'function',
              function: { name: tc.name, arguments: tc.argsStr },
            })),
            ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
          }
        : { role: 'assistant', content: assistantText };

    const newLoopMessages: unknown[] = [
      ...(loopState?.loopMessages ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? req.toolResults.map((tr) => ({
            role: 'tool',
            tool_call_id: tr.callId,
            content: tr.result,
          }))
        : req.prompt
          ? [{ role: 'user', content: req.prompt }]
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
