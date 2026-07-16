/**
 * OpenAI-compatible Chat Completions stateless agentic tool loop.
 *
 * Stateless — history is replayed from DB every turn. In-loop accumulation uses
 * turn-local state only, never a durable cross-turn cursor.
 */

import type OpenAI from 'openai';
import { parseJsonWith } from '../../../lib/safe-parse';
import { streamChatCompletionsAgentTurnLoop } from '../core/agent-turn-stream-loop';
import { appendAttachmentFallbackNotes } from '../core/attachment-content';
import { getModelContextLimit } from '../core/context-policy';
import { createContinuationEnvelope } from '../core/continuation-envelope';
import { buildChatCompletionsReplay } from '../core/replay-builder';
import { toolDefsToChatCompletions } from '../core/tool-mapper';
import { extractReasoningChunks } from '../openai/normalizers';
import type { AgentEvent, AgentTurnRequest, StructuredOutputConfig } from '../types';

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

function parseOAICompatTurnLocalLoopState(
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
  const providerPrompt = buildOAICompatProviderPrompt(req);

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
  } else if (providerPrompt !== undefined) {
    messages.push({ role: 'user', content: providerPrompt });
  }

  const responseFormat = buildResponseFormat(req.generationConfig?.structuredOutput);

  yield* streamChatCompletionsAgentTurnLoop({
    signal: req.signal,
    openStream: () =>
      client.chat.completions.create(
        {
          model: req.modelName,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          ...(responseFormat ? { response_format: responseFormat } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal }
      ),
    extractReasoningChunks,
    complete: ({ accumulator, context }) => {
      // Build the assistant message for loop-state accumulation.
      // reasoning_content is only included on intra-turn loop messages (when tool calls are
      // still pending) to satisfy DeepSeek's requirement that reasoning context is available
      // during continuation. It is intentionally OMITTED from the final message (no pending
      // tool calls) so reasoning is never persisted cross-turn.
      // See: https://api-docs.deepseek.com/guides/thinking_mode
      const assistantMsg =
        accumulator.buildAssistantMessage() as unknown as OpenAI.ChatCompletionMessageParam;
      const newLoopMessages = buildOAICompatLoopMessages(
        turnLocalLoopState?.loopMessages,
        req,
        providerPrompt,
        assistantMsg
      );
      const envelope = createContinuationEnvelope(
        'openai-compatible',
        'stateless-loop',
        req,
        undefined,
        context.providerReportedInputTokens !== undefined
          ? {
              providerReportedInputTokens: context.providerReportedInputTokens,
              contextLimit: getModelContextLimit(req.modelName),
            }
          : undefined
      );

      return [
        {
          type: 'turn_completed' as const,
          providerState: JSON.stringify({ ...envelope, loopMessages: newLoopMessages }),
        },
      ];
    },
    fallbackErrorMessage: 'OpenAI-compatible request failed',
  });
}

function buildOAICompatProviderPrompt(req: AgentTurnRequest): string | undefined {
  if (req.prompt === undefined && (req.attachments?.length ?? 0) === 0) return undefined;
  return appendAttachmentFallbackNotes(req.prompt ?? '', req.attachments, req.modelCapabilities);
}

function buildOAICompatLoopMessages(
  loopMessages: OpenAI.ChatCompletionMessageParam[] | undefined,
  req: AgentTurnRequest,
  providerPrompt: string | undefined,
  assistantMsg: OpenAI.ChatCompletionMessageParam
): OpenAI.ChatCompletionMessageParam[] {
  return [
    ...(loopMessages ?? []),
    ...buildCurrentOAICompatLoopMessages(req, providerPrompt),
    assistantMsg,
  ];
}

function buildCurrentOAICompatLoopMessages(
  req: AgentTurnRequest,
  providerPrompt: string | undefined
): OpenAI.ChatCompletionMessageParam[] {
  if (req.toolResults && req.toolResults.length > 0) {
    return req.toolResults.map(
      (tr): OpenAI.ChatCompletionMessageParam => ({
        role: 'tool',
        tool_call_id: tr.callId,
        content: tr.result,
      })
    );
  }

  return providerPrompt !== undefined ? [{ role: 'user' as const, content: providerPrompt }] : [];
}
