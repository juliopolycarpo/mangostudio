/**
 * OpenAI-compatible Chat Completions stateless agentic tool loop.
 *
 * Stateless — history replayed from DB. In-loop accumulation via providerState.
 * DeepSeek-r1: reasoning_content is automatically included in tool call loop
 * since we replay the full assistant message including any reasoning_content field.
 */

import type OpenAI from 'openai';
import { buildChatCompletionsReplay } from '../core/replay-builder';
import { toolDefsToChatCompletions } from '../core/tool-mapper';
import { computeSystemPromptHash, computeToolsetHash } from '../core/continuation-envelope';
import { extractReasoningChunks } from '../openai/normalizers';
import type { AgentTurnRequest, AgentEvent } from '../types';

/** Opaque loop-state stored in providerState during the tool-call loop. */
interface OAICompatLoopState {
  provider: 'openai-compatible';
  /** Accumulated messages within the current agent turn. */
  loopMessages: Array<OpenAI.ChatCompletionMessageParam>;
}

export function parseOAICompatLoopState(
  providerState: string | null | undefined
): OAICompatLoopState | null {
  if (!providerState) return null;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    if (parsed.provider === 'openai-compatible' && Array.isArray(parsed.loopMessages)) {
      return parsed as unknown as OAICompatLoopState;
    }
  } catch {
    // Ignore malformed state
  }
  return null;
}

/**
 * Streams a single agentic turn for OpenAI-compatible endpoints.
 */
export async function* streamOAICompatAgentTurn(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncIterable<AgentEvent> {
  const loopState = parseOAICompatLoopState(req.providerState);
  const tools =
    req.toolDefinitions && req.toolDefinitions.length > 0
      ? toolDefsToChatCompletions(req.toolDefinitions)
      : undefined;

  // Build messages: system + structured DB history + accumulated loop messages + current input
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...buildChatCompletionsReplay(req.history),
    ...(loopState?.loopMessages ?? []),
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

  try {
    const stream = await client.chat.completions.create(
      {
        model: req.modelName,
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        stream: true,
      },
      { signal: req.signal }
    );

    // Accumulate the full assistant message for loop-state
    let assistantText = '';
    let assistantReasoning = '';
    const pendingToolCalls = new Map<number, { callId: string; name: string; argsStr: string }>();

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta as unknown as Record<string, unknown>;

      // Multi-field reasoning extraction — see extractReasoningChunks for details.
      for (const reasoningChunk of extractReasoningChunks(delta)) {
        assistantReasoning += reasoningChunk;
        yield { type: 'reasoning_delta', text: reasoningChunk };
      }

      if (typeof delta.content === 'string' && delta.content) {
        assistantText += delta.content;
        yield { type: 'assistant_text_delta', text: delta.content };
      }

      // Tool call streaming
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tcDelta of toolCalls) {
          const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
          const fn = tcDelta.function as Record<string, unknown> | undefined;

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
      ...(loopState?.loopMessages ?? []),
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
    };

    yield { type: 'turn_completed', providerState: JSON.stringify(envelopeWithLoop) };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'OpenAI-compatible request failed',
    };
  }
}
