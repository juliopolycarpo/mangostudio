/**
 * Anthropic stateless agentic tool loop streaming.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { createContinuationEnvelope } from '../core/continuation-envelope';
import { getModelContextLimit } from '../core/context-policy';
import { buildCachedAnthropicRequest } from './cached-request';
import {
  isToolUseBlock,
  narrowDelta,
  extractCacheUsage,
  toMessageCreateParams,
} from './normalizers';
import type { AgentTurnRequest, AgentEvent } from '../types';
import { parseJsonWith } from '../../../lib/safe-parse';

/** Opaque loop-state stored in providerState during the tool-call loop. */
interface AnthropicLoopState {
  provider: 'anthropic';
  loopMessages: Array<Anthropic.MessageParam>;
}

export function parseAnthropicLoopState(
  providerState: string | null | undefined
): AnthropicLoopState | null {
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider !== 'anthropic' || !Array.isArray(parsed.loopMessages)) return null;
    return parsed as unknown as AnthropicLoopState;
  });
}

/**
 * Streams a single agentic turn for Anthropic.
 * Stateless — DB history is replayed on each turn; in-loop accumulation via providerState.
 */
export async function* streamAnthropicAgentTurn(
  client: Anthropic,
  req: AgentTurnRequest
): AsyncIterable<AgentEvent> {
  const loopState = parseAnthropicLoopState(req.providerState);
  const thinkingEnabled = req.generationConfig?.thinkingEnabled ?? false;
  const effort = req.generationConfig?.reasoningEffort ?? 'medium';
  const budgetMap: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 8192,
    xhigh: 8192,
    max: 8192,
  };

  // Anthropic Messages API has no native JSON Schema constraint. Structured
  // output for Claude is achieved through prompt engineering and must be
  // opted into by the caller — surface the mismatch loudly so callers can see
  // their request was dropped instead of silently ignored.
  if (req.generationConfig?.structuredOutput) {
    console.warn(
      `[anthropic][structured-output] ignoring structuredOutput request for model=${req.modelName}` +
        `: Anthropic Messages API does not expose a native JSON Schema constraint`
    );
  }

  // Build messages: DB history + accumulated loop messages + current input
  const messages: Anthropic.MessageParam[] = [
    ...req.history.map(
      (turn): Anthropic.MessageParam => ({
        role: turn.role === 'ai' ? 'assistant' : 'user',
        content: turn.text,
      })
    ),
    ...(loopState?.loopMessages ?? []),
  ];

  // Add current input: tool results or user prompt
  if (req.toolResults && req.toolResults.length > 0) {
    messages.push({
      role: 'user',
      content: req.toolResults.map((tr) => ({
        type: 'tool_result' as const,
        tool_use_id: tr.callId,
        content: tr.result,
        is_error: tr.isError ?? false,
      })),
    });
  } else if (req.prompt) {
    messages.push({ role: 'user', content: req.prompt });
  }

  // Build request with prompt caching
  const cachedReq = buildCachedAnthropicRequest({
    systemPrompt: req.systemPrompt ?? '',
    toolDefinitions: req.toolDefinitions ?? [],
    messages,
    thinkingConfig: thinkingEnabled
      ? { type: 'enabled', budget_tokens: budgetMap[effort] }
      : undefined,
  });

  const params = { model: req.modelName, ...cachedReq };

  try {
    const stream = client.messages.stream(toMessageCreateParams(params), {
      signal: req.signal,
    });

    const assistantContent: Anthropic.ContentBlock[] = [];
    const blockByIndex = new Map<number, { callId: string; name: string; inputStr: string }>();

    for await (const event of stream) {
      if (req.signal?.aborted) break;

      if (event.type === 'content_block_start') {
        if (isToolUseBlock(event.content_block)) {
          const callId = event.content_block.id || `tu_${Date.now()}_${event.index}`;
          const name = event.content_block.name;
          blockByIndex.set(event.index, { callId, name, inputStr: '' });
          yield { type: 'tool_call_started', callId, name };
        }
      } else if (event.type === 'content_block_delta') {
        const nd = narrowDelta(event.delta);
        if (nd.kind === 'thinking') {
          yield { type: 'reasoning_delta', text: nd.thinking };
        } else if (nd.kind === 'text') {
          yield { type: 'assistant_text_delta', text: nd.text };
        } else if (nd.kind === 'input_json') {
          const block = blockByIndex.get(event.index);
          if (block) {
            block.inputStr += nd.partial_json;
            yield {
              type: 'tool_call_arguments_delta',
              callId: block.callId,
              delta: nd.partial_json,
            };
          }
        }
      } else if (event.type === 'content_block_stop') {
        const block = blockByIndex.get(event.index);
        if (block) {
          yield {
            type: 'tool_call_completed',
            callId: block.callId,
            name: block.name,
            arguments: block.inputStr,
          };
          blockByIndex.delete(event.index);
        }
      } else if (event.type === 'message_stop') {
        const finalMsg = await stream.finalMessage();
        for (const block of finalMsg.content) {
          assistantContent.push(block);
        }
      }
    }

    let providerReportedInputTokens: number | undefined;
    try {
      const finalMsg = await stream.finalMessage();
      const cu = extractCacheUsage(finalMsg.usage);
      if (cu.inputTokens > 0) providerReportedInputTokens = cu.inputTokens;
      if (cu.cachedTokens > 0 || cu.cacheCreationTokens > 0) {
        console.warn(
          `[prefix-cache][anthropic] read=${cu.cachedTokens} creation=${cu.cacheCreationTokens} total=${cu.inputTokens} tokens` +
            (cu.inputTokens > 0
              ? ` (${Math.round((cu.cachedTokens / cu.inputTokens) * 100)}% cache hit)`
              : '')
        );
      }
    } catch {
      // Non-critical — don't block the response for cache logging
    }

    const newLoopMessages: Anthropic.MessageParam[] = [
      ...(loopState?.loopMessages ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? [
            {
              role: 'user' as const,
              content: req.toolResults.map((tr) => ({
                type: 'tool_result' as const,
                tool_use_id: tr.callId,
                content: tr.result,
                is_error: tr.isError ?? false,
              })),
            },
          ]
        : req.prompt
          ? [{ role: 'user' as const, content: req.prompt }]
          : []),
      ...(assistantContent.length > 0
        ? [{ role: 'assistant' as const, content: assistantContent }]
        : []),
    ];

    const envelope = createContinuationEnvelope('anthropic', 'stateless-loop', req, undefined, {
      providerReportedInputTokens,
      contextLimit: getModelContextLimit(req.modelName),
    });

    yield {
      type: 'turn_completed',
      providerState: JSON.stringify({ ...envelope, loopMessages: newLoopMessages }),
    };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'Anthropic request failed',
    };
  }
}
