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
import { computeToolsetHash } from '../../utils/hash';
import {
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  computeSystemPromptHash,
  type ContinuationEnvelope,
} from './continuation';
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
  } catch { }
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
 * and a new chain starts with full context replay.
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
          return JSON.parse(tr.result);
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
    // Prepend DB history as Turn array so the new model has full context.
    if (req.history.length > 0) {
      const historyTurns = req.history
        .filter((t) => t.text?.trim())
        .map((t) => ({
          role: t.role === 'ai' ? 'model' : 'user',
          content: t.text,
        }));
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
    const stream = (await ai.interactions.create(
      interactionParams as any
    )) as unknown as AsyncIterable<Record<string, any>>;

    // Track active function calls by content index
    const activeCalls = new Map<
      number,
      { id: string; name: string; args: Record<string, unknown>; started: boolean }
    >();
    let interactionId: string | undefined;

    for await (const event of stream) {
      const eventType: string = event.event_type ?? '';

      if (eventType === 'content.start') {
        const content = event.content as Record<string, any> | undefined;
        if (!content) continue;

        if (content.type === 'function_call') {
          const callId: string =
            content.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const name: string = content.name ?? '';
          activeCalls.set(event.index as number, {
            id: callId,
            name,
            args: {},
            started: false,
          });
          // Defer tool_call_started if name is empty — the delta will provide it
          if (name) {
            activeCalls.get(event.index as number)!.started = true;
            yield { type: 'tool_call_started', callId, name };
          }
        }
        // thought content.start — nothing to emit yet, deltas carry the summary text
      } else if (eventType === 'content.delta') {
        const delta = event.delta as Record<string, any> | undefined;
        if (!delta) continue;

        if (delta.type === 'thought_summary') {
          // Streaming thought summary text
          const text =
            typeof delta.content === 'string'
              ? delta.content
              : ((delta.content as Record<string, any>)?.text ?? '');
          if (text) {
            yield { type: 'reasoning_delta', text };
          }
        } else if (delta.type === 'text') {
          yield { type: 'assistant_text_delta', text: delta.text ?? '' };
        } else if (delta.type === 'function_call') {
          // Incremental arguments for an active tool call
          const call = activeCalls.get(event.index as number);
          if (call) {
            // Capture name from delta if content.start didn't have it
            if (delta.name && !call.name) call.name = delta.name as string;
            if (!call.started && call.name) {
              call.started = true;
              yield { type: 'tool_call_started', callId: call.id, name: call.name };
            }
            const partialArgs = (delta.arguments ?? {}) as Record<string, unknown>;
            Object.assign(call.args, partialArgs);
            const argChunk = JSON.stringify(partialArgs);
            yield { type: 'tool_call_arguments_delta', callId: call.id, delta: argChunk };
          }
        } else if (delta.type !== 'thought_signature') {
          // Log unknown delta types for future diagnostics
          console.log('[gemini-interactions] unknown delta type:', JSON.stringify(delta));
        }
      } else if (eventType === 'content.stop') {
        // Finalize any active function call at this index
        const call = activeCalls.get(event.index as number);
        if (call) {
          yield {
            type: 'tool_call_completed',
            callId: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          };
          activeCalls.delete(event.index as number);
        }
      } else if (eventType === 'interaction.complete') {
        const interaction = event.interaction as Record<string, any> | undefined;
        interactionId = interaction?.id;

        // Log cache usage if available
        const usage = interaction?.usage as Record<string, any> | undefined;
        if (usage) {
          const cached = usage.cached_content_token_count ?? usage.cachedContentTokenCount ?? 0;
          const total = usage.prompt_token_count ?? usage.promptTokenCount ?? 0;
          if (cached > 0 && total > 0) {
            console.log(
              `[prefix-cache][gemini] ${cached}/${total} input tokens from cache (${Math.round((cached / total) * 100)}%)`
            );
          }
        }
      } else if (eventType === 'interaction.start') {
        const interaction = event.interaction as Record<string, any> | undefined;
        if (interaction?.id) interactionId = interaction.id;
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
    };

    yield { type: 'turn_completed', providerState: serializeContinuationEnvelope(envelope) };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'Gemini interaction failed',
    };
  }
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
      capabilities: {
        text: catalog.discoveredTextModels.some((t) => t.modelId === m.modelId),
        image: catalog.discoveredImageModels.some((i) => i.modelId === m.modelId),
        streaming: true,
        reasoning: isReasoningModel(m.modelId),
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
