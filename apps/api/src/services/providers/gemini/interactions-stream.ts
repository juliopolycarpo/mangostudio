/**
 * Gemini Interactions API agentic turn streaming.
 *
 * Stateful — uses `previous_interaction_id` for server-side continuation.
 * Degrades gracefully to full stateless replay on cursor loss.
 */

import { computeToolsetHash } from '../../../utils/hash';
import {
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  computeSystemPromptHash,
  type ContinuationEnvelope,
} from '../core/continuation-envelope';
import { getModelContextLimit } from '../core/context-policy';
import { buildGeminiInteractionsReplay } from '../core/replay-builder';
import { toolDefsToGeminiInteractions } from '../core/tool-mapper';
import {
  isFunctionCallStart,
  narrowGeminiDelta,
  extractGeminiUsage,
  type InteractionSSEEvent,
  type CreateModelInteractionParamsStreaming,
} from './normalizers';
import { getResolvedGeminiApiKey } from './secret';
import { createGeminiClient } from './client';
import type { AgentTurnRequest, AgentEvent } from '../types';

/**
 * Opaque state persisted across turns for Gemini.
 */
interface GeminiInteractionState {
  provider: 'gemini';
  mode: 'interactions';
  interactionId: string;
  modelName: string;
  toolsetHash: string;
}

function parseGeminiState(providerState: string | null | undefined): GeminiInteractionState | null {
  const envelope = parseContinuationEnvelope(providerState);
  if (envelope?.provider === 'gemini' && envelope.cursor) {
    return {
      provider: 'gemini',
      mode: 'interactions',
      interactionId: envelope.cursor,
      modelName: envelope.modelName,
      toolsetHash: envelope.toolsetHash,
    };
  }
  if (!providerState) return null;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    if (parsed.provider === 'gemini' && parsed.mode === 'interactions') {
      return parsed as unknown as GeminiInteractionState;
    }
  } catch {
    // Ignore malformed state
  }
  return null;
}

/**
 * Streams a single agentic turn using the Gemini Interactions API.
 */
export async function* streamGeminiAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
  const apiKey = await getResolvedGeminiApiKey(req.userId, req.modelName);
  const ai = createGeminiClient(apiKey);

  const prevState = parseGeminiState(req.providerState);
  const toolDefs = req.toolDefinitions ?? [];
  const currentToolsetHash = computeToolsetHash(toolDefs);

  const canContinue =
    prevState !== null &&
    prevState.modelName === req.modelName &&
    prevState.toolsetHash === currentToolsetHash;

  let input: unknown;
  if (req.toolResults && req.toolResults.length > 0) {
    input = req.toolResults.map((tr) => ({
      type: 'function_result' as const,
      call_id: tr.callId,
      name: tr.name,
      result: (() => {
        try {
          return JSON.parse(tr.result) as unknown;
        } catch {
          return tr.result;
        }
      })(),
      is_error: tr.isError ?? false,
    }));
  } else if (req.prompt) {
    input = req.prompt;
  } else {
    yield { type: 'turn_error', error: 'No input for Gemini interaction' };
    return;
  }

  const interactionParams: Record<string, unknown> = { model: req.modelName, input };

  if (canContinue) {
    interactionParams.previous_interaction_id = prevState.interactionId;
  } else {
    if (req.history.length > 0) {
      const historyTurns = buildGeminiInteractionsReplay(req.history);
      const currentContent =
        typeof input === 'string' ? input : (input as unknown[]).length > 0 ? input : undefined;
      interactionParams.input = [
        ...historyTurns,
        ...(currentContent !== undefined ? [{ role: 'user', content: currentContent }] : []),
      ];
    }

    if (req.systemPrompt?.trim()) {
      interactionParams.system_instruction = req.systemPrompt;
    }
    if (toolDefs.length > 0) {
      interactionParams.tools = toolDefsToGeminiInteractions(toolDefs);
    }
  }

  if (req.generationConfig?.thinkingEnabled) {
    const levelMap = { low: 'low', medium: 'medium', high: 'high' } as const;
    interactionParams.generation_config = {
      thinking_level: levelMap[req.generationConfig.reasoningEffort] ?? 'medium',
      thinking_summaries: 'auto',
    };
  }

  try {
    interactionParams.stream = true;
    const stream = await ai.interactions.create(
      interactionParams as unknown as CreateModelInteractionParamsStreaming
    );

    yield* processGeminiInteractionStream(stream, req, currentToolsetHash);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    const isCursorError =
      canContinue &&
      prevState !== null &&
      (/not found/i.test(errMsg) ||
        /expired/i.test(errMsg) ||
        /invalid.*interaction/i.test(errMsg) ||
        /INVALID_ARGUMENT/.test(errMsg) ||
        /NOT_FOUND/.test(errMsg));

    if (isCursorError) {
      console.warn(
        `[fallback][degrade] provider=gemini reason=cursor_error` +
          ` model=${req.modelName} falling back to stateless replay`
      );

      yield {
        type: 'continuation_degraded',
        from: 'interactions',
        to: 'replay',
        reason: `interaction_expired: ${errMsg}`,
      };

      try {
        const historyTurns = buildGeminiInteractionsReplay(req.history);
        const currentContent =
          typeof input === 'string'
            ? input
            : Array.isArray(input) && (input as unknown[]).length > 0
              ? input
              : undefined;

        const retryParams: Record<string, unknown> = {
          model: req.modelName,
          input: [
            ...historyTurns,
            ...(currentContent !== undefined ? [{ role: 'user', content: currentContent }] : []),
          ],
          stream: true,
        };

        if (req.systemPrompt?.trim()) {
          retryParams.system_instruction = req.systemPrompt;
        }
        if (toolDefs.length > 0) {
          retryParams.tools = toolDefsToGeminiInteractions(toolDefs);
        }
        if (req.generationConfig?.thinkingEnabled) {
          const levelMap = { low: 'low', medium: 'medium', high: 'high' } as const;
          retryParams.generation_config = {
            thinking_level: levelMap[req.generationConfig.reasoningEffort] ?? 'medium',
            thinking_summaries: 'auto',
          };
        }

        const retryStream = await ai.interactions.create(
          retryParams as unknown as CreateModelInteractionParamsStreaming
        );

        yield* processGeminiInteractionStream(retryStream, req, currentToolsetHash);
      } catch (retryErr: unknown) {
        yield {
          type: 'turn_error',
          error:
            retryErr instanceof Error ? retryErr.message : 'Gemini retry after cursor loss failed',
        };
      }
    } else {
      yield { type: 'turn_error', error: errMsg };
    }
  }
}

/**
 * Processes a Gemini Interactions streaming response and yields AgentEvents.
 * Used by both the primary path and the cursor-loss retry path.
 */
export async function* processGeminiInteractionStream(
  stream: AsyncIterable<InteractionSSEEvent>,
  req: AgentTurnRequest,
  currentToolsetHash: string
): AsyncIterable<AgentEvent> {
  const activeCalls = new Map<
    number,
    { id: string; name: string; args: Record<string, unknown>; started: boolean }
  >();
  let interactionId: string | undefined;
  let providerReportedInputTokens: number | undefined;

  for await (const event of stream) {
    if (event.event_type === 'content.start') {
      if (isFunctionCallStart(event.content)) {
        const callId =
          event.content.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const name = event.content.name;
        const callEntry = { id: callId, name, args: {}, started: false };
        activeCalls.set(event.index, callEntry);
        if (name) {
          callEntry.started = true;
          yield { type: 'tool_call_started', callId, name };
        }
      }
    } else if (event.event_type === 'content.delta') {
      const nd = narrowGeminiDelta(event.delta);
      if (nd.kind === 'thought_summary') {
        if (nd.text) {
          yield { type: 'reasoning_delta', text: nd.text };
        }
      } else if (nd.kind === 'text') {
        yield { type: 'assistant_text_delta', text: nd.text };
      } else if (nd.kind === 'function_call') {
        const call = activeCalls.get(event.index);
        if (call) {
          if (nd.name && !call.name) call.name = nd.name;
          if (!call.started && call.name) {
            call.started = true;
            yield { type: 'tool_call_started', callId: call.id, name: call.name };
          }
          Object.assign(call.args, nd.args);
          const argChunk = JSON.stringify(nd.args);
          yield { type: 'tool_call_arguments_delta', callId: call.id, delta: argChunk };
        }
      } else if (nd.kind !== 'thought_signature') {
        console.warn('[gemini-interactions] unknown delta type:', JSON.stringify(event.delta));
      }
    } else if (event.event_type === 'content.stop') {
      const call = activeCalls.get(event.index);
      if (call) {
        yield {
          type: 'tool_call_completed',
          callId: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        };
        activeCalls.delete(event.index);
      }
    } else if (event.event_type === 'interaction.complete') {
      interactionId = event.interaction.id;
      const gu = extractGeminiUsage(event.interaction.usage);
      if (gu.totalInputTokens > 0) providerReportedInputTokens = gu.totalInputTokens;
      if (gu.cachedTokens > 0 && gu.totalInputTokens > 0) {
        console.warn(
          `[prefix-cache][gemini] ${gu.cachedTokens}/${gu.totalInputTokens} input tokens from cache (${Math.round((gu.cachedTokens / gu.totalInputTokens) * 100)}%)`
        );
      }
    } else if (event.event_type === 'interaction.start') {
      interactionId = event.interaction.id;
    }
  }

  if (!interactionId) {
    yield { type: 'turn_error', error: 'No interaction ID returned from Gemini streaming' };
    return;
  }

  const envelope: ContinuationEnvelope = {
    schemaVersion: 1,
    provider: 'gemini',
    mode: 'interactions',
    modelName: req.modelName,
    systemPromptHash: computeSystemPromptHash(req.systemPrompt),
    toolsetHash: currentToolsetHash,
    cursor: interactionId,
    context: {
      providerReportedInputTokens,
      contextLimit: getModelContextLimit(req.modelName),
      lastUpdatedAt: Date.now(),
    },
  };

  yield { type: 'turn_completed', providerState: serializeContinuationEnvelope(envelope) };
}
