import type OpenAI from 'openai';
import { parseJsonWith } from '../../../lib/safe-parse';
import { streamChatCompletionsAgentTurnLoop } from '../core/agent-turn-stream-loop';
import { getModelContextLimit } from '../core/context-policy';
import { createContinuationEnvelope } from '../core/continuation-envelope';
import { extractReasoningChunks } from '../openai/normalizers';
import type { AgentEvent, AgentTurnRequest } from '../types';
import {
  buildDeepSeekAgentMessages,
  buildDeepSeekProviderPrompt,
  buildDeepSeekRequestBody,
  buildDeepSeekTools,
  type DeepSeekTurnLoopState,
} from './message-mapper';

export function parseDeepSeekLoopState(
  providerState: string | null | undefined
): DeepSeekTurnLoopState | null {
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider !== 'deepseek' || !Array.isArray(parsed.loopMessages)) return null;
    return parsed as unknown as DeepSeekTurnLoopState;
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

  const messages = buildDeepSeekAgentMessages({
    systemPrompt: req.systemPrompt,
    history: req.history,
    loopMessages: loopState?.loopMessages,
    toolResults: req.toolResults,
    prompt: req.prompt,
    attachments: req.attachments,
    modelCapabilities: req.modelCapabilities,
  });

  const tools = buildDeepSeekTools(req.toolDefinitions);

  const body = buildDeepSeekRequestBody({
    modelName: req.modelName,
    messages,
    tools,
    thinkingEnabled,
    reasoningEffort,
    signal: req.signal,
  });

  yield* streamChatCompletionsAgentTurnLoop({
    signal: req.signal,
    openStream: () =>
      client.chat.completions.create(
        body as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: req.signal }
      ),
    extractReasoningChunks,
    complete: ({ accumulator, context }) => {
      const assistantMsg = accumulator.buildAssistantMessage();
      const newLoopMessages = buildDeepSeekLoopMessages(
        loopState?.loopMessages,
        req,
        providerPrompt,
        assistantMsg
      );
      const envelope = createContinuationEnvelope('deepseek', 'stateless-loop', req, undefined, {
        ...(context.providerReportedInputTokens !== undefined
          ? { providerReportedInputTokens: context.providerReportedInputTokens }
          : {}),
        contextLimit: getModelContextLimit(req.modelName),
      });
      const providerState: Record<string, unknown> = {
        ...envelope,
        loopMessages: newLoopMessages,
        ...(context.promptCacheHitTokens !== undefined
          ? { promptCacheHitTokens: context.promptCacheHitTokens }
          : {}),
        ...(context.promptCacheMissTokens !== undefined
          ? { promptCacheMissTokens: context.promptCacheMissTokens }
          : {}),
      };

      return [{ type: 'turn_completed' as const, providerState: JSON.stringify(providerState) }];
    },
    fallbackErrorMessage: 'DeepSeek request failed',
  });
}

function buildDeepSeekLoopMessages(
  loopMessages: DeepSeekTurnLoopState['loopMessages'] | undefined,
  req: AgentTurnRequest,
  providerPrompt: string | undefined,
  assistantMsg: Record<string, unknown>
): unknown[] {
  return [
    ...(loopMessages ?? []),
    ...buildCurrentDeepSeekLoopMessages(req, providerPrompt),
    assistantMsg,
  ];
}

function buildCurrentDeepSeekLoopMessages(
  req: AgentTurnRequest,
  providerPrompt: string | undefined
): unknown[] {
  if (req.toolResults && req.toolResults.length > 0) {
    return req.toolResults.map((tr) => ({
      role: 'tool',
      tool_call_id: tr.callId,
      content: tr.result,
    }));
  }

  return providerPrompt !== undefined ? [{ role: 'user', content: providerPrompt }] : [];
}
