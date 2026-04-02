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
    const levelMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } as const;
    interactionParams.generation_config = {
      thinking_level: levelMap[req.generationConfig.reasoningEffort] ?? 'MEDIUM',
    };
  }

  try {
    const interaction = await ai.interactions.create(interactionParams as any);

    if (!interaction.outputs || interaction.outputs.length === 0) {
      yield { type: 'turn_error', error: 'No response from Gemini Interactions API' };
      return;
    }

    // Process outputs and emit AgentEvents
    for (const output of interaction.outputs) {
      const o = output as Record<string, any>;

      if (o.type === 'function_call') {
        const callId: string = o.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const name: string = o.name ?? '';
        const argsStr = JSON.stringify(o.arguments ?? {});
        yield { type: 'tool_call_started', callId, name };
        yield { type: 'tool_call_completed', callId, name, arguments: argsStr };
      } else if (o.type === 'thought') {
        // Thought summaries
        if (o.summary) {
          for (const s of o.summary) {
            if (s.type === 'text' && s.text) {
              yield { type: 'reasoning_delta', text: s.text };
            }
          }
        }
      } else if (o.type === 'text') {
        yield { type: 'assistant_text_delta', text: o.text ?? '' };
      }
    }

    // Log cache usage if available
    if (interaction.usage) {
      const usage = interaction.usage as Record<string, any>;
      const cached = usage.cached_content_token_count ?? usage.cachedContentTokenCount ?? 0;
      const total = usage.prompt_token_count ?? usage.promptTokenCount ?? 0;
      if (cached > 0 && total > 0) {
        console.log(
          `[prefix-cache][gemini] ${cached}/${total} input tokens from cache (${Math.round((cached / total) * 100)}%)`
        );
      }
    }

    // Persist interaction state for continuation
    const newState: GeminiInteractionState = {
      provider: 'gemini',
      mode: 'interactions',
      interactionId: interaction.id,
      modelName: req.modelName,
      toolsetHash: currentToolsetHash,
    };

    yield { type: 'turn_completed', providerState: JSON.stringify(newState) };
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
