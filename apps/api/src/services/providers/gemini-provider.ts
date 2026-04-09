/**
 * AIProvider adapter that wraps the existing Gemini service functions.
 * Delegates to services/gemini/* without duplicating any logic.
 */

import { GoogleGenAI } from '@google/genai';
import {
  clearGeminiModelCatalog,
  generateText as geminiGenerateText,
  generateTextStream as geminiGenerateTextStream,
  generateImage as geminiGenerateImage,
  getResolvedGeminiApiKey,
  syncGeminiConfigFileConnectors,
  validateGeminiApiKey,
  getGeminiModelCatalog,
} from '../gemini';
import { isReasoningModel } from '@mangostudio/shared/utils/model-detection';
import { registerProvider } from './registry';
import {
  type InteractionSSEEvent,
  type CreateModelInteractionParamsStreaming,
  isFunctionCallStart,
  narrowGeminiDelta,
  extractGeminiUsage,
} from './gemini-normalizers';
import { computeToolsetHash } from '../../utils/hash';
import {
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  computeSystemPromptHash,
  type ContinuationEnvelope,
} from './continuation';
import { getModelContextLimit } from './context-policy';
import { buildGeminiInteractionsReplay } from './replay-builder';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingChunk,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
  AgentTurnRequest,
  AgentEvent,
  ToolDefinition,
} from './types';

// ---------------------------------------------------------------------------
// Gemini stateful agentic turn via Interactions API
// ---------------------------------------------------------------------------

/**
 * Opaque state persisted across turns for Gemini.
 * - interactionId: server-side cursor for stateful continuation
 * - toolsetHash: detects when tools change (requires new interaction chain)
 */
interface GeminiInteractionState {
  provider: 'gemini';
  mode: 'interactions';
  interactionId: string;
  modelName: string;
  toolsetHash: string;
}

function parseGeminiState(providerState: string | null | undefined): GeminiInteractionState | null {
  // Try new envelope format first
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
  // Legacy fallback
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

function toolDefsToInteractions(
  defs: ToolDefinition[]
): Array<{ type: 'function'; name: string; description: string; parameters: unknown }> {
  return defs.map((def) => ({
    type: 'function' as const,
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  }));
}

/**
 * Streams a single agentic turn using the Gemini Interactions API.
 *
 * Stateful — uses `previous_interaction_id` for server-side continuation.
 * On the first turn of a chat, sends system_instruction + tools + full input.
 * On subsequent turns, only sends the new delta input; the server retains
 * the full context window via the interaction chain.
 *
 * When tools or model change between turns, the interaction chain is broken
 * and a new chain starts with full structured history replay (preserving
 * tool-call/tool-result turns from persisted parts).
 */
async function* streamGeminiAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
  const apiKey = await getResolvedGeminiApiKey(req.userId, req.modelName);
  const ai = new GoogleGenAI({ apiKey });

  const prevState = parseGeminiState(req.providerState);
  const toolDefs = req.toolDefinitions ?? [];
  const currentToolsetHash = computeToolsetHash(toolDefs);

  // Determine if we can continue the existing interaction chain.
  // Chain is valid when: same model + same toolset + previous interaction exists.
  const canContinue =
    prevState !== null &&
    prevState.modelName === req.modelName &&
    prevState.toolsetHash === currentToolsetHash;

  // Build the input for this iteration
  let input: unknown;
  if (req.toolResults && req.toolResults.length > 0) {
    // Feed tool results back to the model
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

  const interactionParams: Record<string, unknown> = {
    model: req.modelName,
    input,
  };

  if (canContinue) {
    // Continue the chain — server already has system_instruction, tools, and history
    interactionParams.previous_interaction_id = prevState.interactionId;
  } else {
    // New chain (first turn or model/tool change).
    // Replay full structured history including tool interactions from persisted parts.
    if (req.history.length > 0) {
      const historyTurns = buildGeminiInteractionsReplay(req.history);
      // Wrap: history turns + current input as the last user turn
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
      interactionParams.tools = toolDefsToInteractions(toolDefs);
    }
  }

  // Thinking / reasoning config
  if (req.generationConfig?.thinkingEnabled) {
    const levelMap = { low: 'low', medium: 'medium', high: 'high' } as const;
    interactionParams.generation_config = {
      thinking_level: levelMap[req.generationConfig.reasoningEffort] ?? 'medium',
      thinking_summaries: 'auto',
    };
  }

  try {
    // Use streaming mode so thinking, tool calls, and text appear progressively
    interactionParams.stream = true;
    const stream = await ai.interactions.create(
      interactionParams as unknown as CreateModelInteractionParamsStreaming
    );

    yield* processGeminiInteractionStream(stream, req, currentToolsetHash);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Detect server-side cursor rejection: interaction not found, expired, or invalid
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

      // Retry without previous_interaction_id: full stateless replay
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
          retryParams.tools = toolDefsToInteractions(toolDefs);
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
      yield {
        type: 'turn_error',
        error: errMsg,
      };
    }
  }
}

/**
 * Processes a Gemini Interactions streaming response and yields AgentEvents.
 * Used by both the primary path and the cursor-loss retry path.
 */
async function* processGeminiInteractionStream(
  stream: AsyncIterable<InteractionSSEEvent>,
  req: AgentTurnRequest,
  currentToolsetHash: string
): AsyncIterable<AgentEvent> {
  // Track active function calls by content index
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

  // Persist interaction state as continuation envelope
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

const geminiProvider: AIProvider = {
  providerType: 'gemini',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const text = await geminiGenerateText(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName
    );
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    for await (const chunk of geminiGenerateTextStream(
      req.userId,
      req.history,
      req.prompt,
      req.systemPrompt,
      req.modelName,
      req.generationConfig
    )) {
      if (req.signal?.aborted) break;
      yield chunk;
    }
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    yield* streamGeminiAgentTurn(req);
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const imageUrl = await geminiGenerateImage(
      req.userId,
      req.prompt,
      req.systemPrompt,
      req.referenceImageUrl,
      req.imageSize ?? '1K',
      req.modelName
    );
    return { imageUrl };
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    const catalog = await getGeminiModelCatalog(userId);
    return catalog.allModels.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      description: m.description,
      provider: 'gemini' as const,
      inputTokenLimit: m.inputTokenLimit,
      capabilities: {
        text: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        image: catalog.discoveredImageModels.some((i) => i.modelId === m.modelId),
        streaming: true,
        reasoning: isReasoningModel(m.modelId),
        tools: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        statefulContinuation: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        promptCaching: true,
        parallelToolCalls: false,
        reasoningWithTools: isReasoningModel(m.modelId),
      },
    }));
  },

  invalidateModelCache(userId?: string): void {
    if (userId) {
      clearGeminiModelCatalog(userId);
    }
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await syncGeminiConfigFileConnectors(userId);
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await validateGeminiApiKey(apiKey);
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    return getResolvedGeminiApiKey(userId, modelName);
  },
};

// Self-register on import
registerProvider(geminiProvider);

export { geminiProvider };
