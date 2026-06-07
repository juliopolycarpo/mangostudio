/**
 * Anthropic stateless agentic tool loop streaming.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { createDiagnosticLogger } from '../../../lib/logger';
import type { AgentEvent, AgentTurnRequest } from '../types';
import { buildCachedAnthropicRequest } from './cached-request';
import {
  buildAnthropicCurrentInput,
  buildAnthropicLoopMessages,
  buildAnthropicProviderPrompt,
  buildAnthropicRequestMessages,
  parseAnthropicLoopState,
  serializeAnthropicTurnState,
} from './loop-state';
import { extractCacheUsage, toMessageCreateParams } from './normalizers';
import { createAnthropicStreamAccumulator } from './stream-accumulator';
import { buildAnthropicThinkingConfig } from './thinking-config';

export { parseAnthropicLoopState } from './loop-state';

const anthropicStreamLogger = createDiagnosticLogger('anthropic-stream');

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

  // Anthropic Messages API has no native JSON Schema constraint. Structured
  // output for Claude is achieved through prompt engineering and must be
  // opted into by the caller — surface the mismatch loudly so callers can see
  // their request was dropped instead of silently ignored.
  if (req.generationConfig?.structuredOutput) {
    anthropicStreamLogger.warn('structured_output_ignored', { model: req.modelName });
  }

  const providerPrompt = buildAnthropicProviderPrompt(req);
  const currentInput = buildAnthropicCurrentInput(req, providerPrompt);
  const messages = buildAnthropicRequestMessages(req, loopState, currentInput);

  const cachedReq = buildCachedAnthropicRequest({
    systemPrompt: req.systemPrompt ?? '',
    toolDefinitions: req.toolDefinitions ?? [],
    messages,
    thinkingConfig: buildAnthropicThinkingConfig(thinkingEnabled, effort),
  });

  const params = { model: req.modelName, ...cachedReq };

  try {
    const stream = client.messages.stream(toMessageCreateParams(params), {
      signal: req.signal,
    });

    const accumulator = createAnthropicStreamAccumulator();
    const assistantContent: Anthropic.ContentBlock[] = [];

    for await (const event of stream) {
      if (req.signal?.aborted) break;

      for (const agentEvent of accumulator.mapEvent(event)) {
        yield agentEvent;
      }

      if (event.type === 'message_stop') {
        const finalMsg = await stream.finalMessage();
        assistantContent.push(...finalMsg.content);
      }
    }

    const providerReportedInputTokens = await reportCacheUsage(stream);
    const newLoopMessages = buildAnthropicLoopMessages(loopState, currentInput, assistantContent);

    yield {
      type: 'turn_completed',
      providerState: serializeAnthropicTurnState(req, newLoopMessages, providerReportedInputTokens),
    };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'Anthropic request failed',
    };
  }
}

/**
 * Reads prompt-cache usage from the final message, logging cache hits.
 * Returns the provider-reported input tokens, or undefined when unavailable.
 * Never throws — usage logging must not block the response.
 */
async function reportCacheUsage(
  stream: ReturnType<Anthropic['messages']['stream']>
): Promise<number | undefined> {
  try {
    const finalMsg = await stream.finalMessage();
    const usage = extractCacheUsage(finalMsg.usage);
    if (usage.cachedTokens > 0 || usage.cacheCreationTokens > 0) {
      anthropicStreamLogger.info('prefix_cache_hit', {
        readTokens: usage.cachedTokens,
        creationTokens: usage.cacheCreationTokens,
        totalInputTokens: usage.inputTokens,
        hitPercent:
          usage.inputTokens > 0 ? Math.round((usage.cachedTokens / usage.inputTokens) * 100) : 0,
      });
    }
    return usage.inputTokens > 0 ? usage.inputTokens : undefined;
  } catch {
    return undefined;
  }
}
