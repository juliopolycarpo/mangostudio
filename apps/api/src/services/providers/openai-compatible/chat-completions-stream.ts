/**
 * OpenAI-compatible Chat Completions stateless agentic tool loop.
 *
 * Stateless — history is replayed from DB every turn. In-loop accumulation uses
 * turn-local state only, never a durable cross-turn cursor.
 */

import type OpenAI from 'openai';
import { buildChatCompletionsReplay } from '../core/replay-builder';
import { toolDefsToChatCompletions } from '../core/tool-mapper';
import type { StructuredOutputConfig } from '../types';
import { computeSystemPromptHash, computeToolsetHash } from '../core/continuation-envelope';
import { getModelContextLimit } from '../core/context-policy';
import { extractReasoningChunks } from '../openai/normalizers';
import type { AgentTurnRequest, AgentEvent } from '../types';
import { parseJsonWith } from '../../../lib/safe-parse';

/**
 * Extended delta shape for OpenAI-compatible endpoints.
 *
 * The OpenAI SDK's `ChatCompletionChunk.Choice.Delta` type only covers
 * standard fields. DeepSeek and OpenRouter add reasoning-related fields
 * that the SDK doesn't model. This interface covers the superset.
 */
interface ExtendedChatDelta extends Record<string, unknown> {
  content?: string | null;
  role?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Array<{ type?: string; text?: string }>;
}

/**
 * Maps a StructuredOutputConfig to the Chat Completions response_format shape.
 * Returns undefined when no structured output is requested.
 */
function buildResponseFormat(
  config: StructuredOutputConfig | undefined
): OpenAI.ResponseFormatJSONSchema | undefined {
  if (!config) return undefined;
  return {
    type: 'json_schema',
    json_schema: {
      name: config.name,
      schema: config.schema,
      strict: config.strict ?? true,
    },
  };
}

/** Opaque loop state carried only between iterations of the current turn. */
interface OAICompatTurnLocalLoopState {
  provider: 'openai-compatible';
  /** Accumulated messages within the current agent turn. */
  loopMessages: Array<OpenAI.ChatCompletionMessageParam>;
}

export function parseOAICompatTurnLocalLoopState(
  turnLocalLoopState: string | null | undefined
): OAICompatTurnLocalLoopState | null {
  return parseJsonWith(turnLocalLoopState, (parsed) => {
    if (parsed.provider !== 'openai-compatible' || !Array.isArray(parsed.loopMessages)) return null;
    return parsed as unknown as OAICompatTurnLocalLoopState;
  });
}

/**
 * Streams a single agentic turn for OpenAI-compatible endpoints.
 */
export async function* streamOAICompatAgentTurn(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncIterable<AgentEvent> {
  const turnLocalLoopState = parseOAICompatTurnLocalLoopState(req.providerState);
  const tools =
    req.toolDefinitions && req.toolDefinitions.length > 0
      ? toolDefsToChatCompletions(req.toolDefinitions)
      : undefined;

  // Build messages: system + structured DB history + accumulated loop messages + current input
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...buildChatCompletionsReplay(req.history),
    ...(turnLocalLoopState?.loopMessages ?? []),
  ];

  // Add current input: tool results or user prompt
  if (req.toolResults && req.toolResults.length > 0) {
    for (const tr of req.toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.callId,
        content: tr.result,
      });
    }
  } else if (req.prompt) {
    messages.push({ role: 'user', content: req.prompt });
  }

  const responseFormat = buildResponseFormat(req.generationConfig?.structuredOutput);

  try {
    const stream = await client.chat.completions.create(
      {
        model: req.modelName,
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal }
    );

    // Accumulate the full assistant message for loop-state
    let assistantText = '';
    let assistantReasoning = '';
    let providerReportedInputTokens: number | undefined;
    const pendingToolCalls = new Map<number, { callId: string; name: string; argsStr: string }>();

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;

      // Usage chunks arrive in the terminal frame (when stream_options.include_usage is set)
      // and typically have an empty choices array. Capture prompt_tokens for context accounting
      // before the continue-on-empty-choices guard below.
      const usage = (chunk as { usage?: { prompt_tokens?: number } }).usage;
      if (usage && typeof usage.prompt_tokens === 'number') {
        providerReportedInputTokens = usage.prompt_tokens;
      }

      const choice = chunk.choices[0];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- choices array may be empty at runtime
      if (!choice) continue;

      // Cast to ExtendedChatDelta — the SDK type doesn't model DeepSeek/OpenRouter reasoning fields
      const delta = choice.delta as ExtendedChatDelta;

      for (const reasoningChunk of extractReasoningChunks(delta)) {
        assistantReasoning += reasoningChunk;
        yield { type: 'reasoning_delta', text: reasoningChunk };
      }

      if (typeof delta.content === 'string' && delta.content) {
        assistantText += delta.content;
        yield { type: 'assistant_text_delta', text: delta.content };
      }

      // Tool call streaming
      const toolCalls = delta.tool_calls;
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

    // Build the assistant message for loop-state accumulation.
    // reasoning_content is only included on intra-turn loop messages (when tool calls are
    // still pending) to satisfy DeepSeek's requirement that reasoning context is available
    // during continuation. It is intentionally OMITTED from the final message (no pending
    // tool calls) so reasoning is never persisted cross-turn.
    // See: https://api-docs.deepseek.com/guides/thinking_mode
    const assistantMsg: OpenAI.ChatCompletionMessageParam =
      pendingToolCalls.size > 0
        ? {
            role: 'assistant',
            content: assistantText || null,
            tool_calls: Array.from(pendingToolCalls.values()).map((tc) => ({
              id: tc.callId,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argsStr },
            })),
            ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
          }
        : { role: 'assistant', content: assistantText };

    const newLoopMessages: OpenAI.ChatCompletionMessageParam[] = [
      ...(turnLocalLoopState?.loopMessages ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? req.toolResults.map(
            (tr): OpenAI.ChatCompletionMessageParam => ({
              role: 'tool',
              tool_call_id: tr.callId,
              content: tr.result,
            })
          )
        : req.prompt
          ? [{ role: 'user' as const, content: req.prompt }]
          : []),
      assistantMsg,
    ];

    // Emit an envelope-compatible state that also carries the loop messages.
    const envelopeWithLoop = {
      schemaVersion: 1 as const,
      provider: 'openai-compatible' as const,
      mode: 'stateless-loop' as const,
      modelName: req.modelName,
      systemPromptHash: computeSystemPromptHash(req.systemPrompt),
      toolsetHash: computeToolsetHash(req.toolDefinitions ?? []),
      loopMessages: newLoopMessages,
      ...(providerReportedInputTokens !== undefined
        ? {
            context: {
              providerReportedInputTokens,
              contextLimit: getModelContextLimit(req.modelName),
              lastUpdatedAt: Date.now(),
            },
          }
        : {}),
    };

    yield { type: 'turn_completed', providerState: JSON.stringify(envelopeWithLoop) };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'OpenAI-compatible request failed',
    };
  }
}
