/**
 * AIProvider adapter that wraps the existing Gemini service functions.
 * Delegates to services/gemini/* without duplicating any logic.
 */

import { GoogleGenAI } from '@google/genai';
import type { Content, Part } from '@google/genai';
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
// Gemini stateless agentic tool loop
// ---------------------------------------------------------------------------

/** Opaque loop-state stored in providerState during the tool-call loop. */
interface GeminiLoopState {
  provider: 'gemini';
  /** In-memory Gemini content turns accumulated within the current agent turn. */
  loopContents: Array<{ role: string; parts: unknown[] }>;
}

function parseGeminiLoopState(providerState: string | null | undefined): GeminiLoopState | null {
  if (!providerState) return null;
  try {
    const parsed = JSON.parse(providerState) as Record<string, unknown>;
    if (parsed.provider === 'gemini' && Array.isArray(parsed.loopContents)) {
      return parsed as unknown as GeminiLoopState;
    }
  } catch {
    // Ignore malformed state
  }
  return null;
}

function toolDefsToGemini(defs: ToolDefinition[]): Record<string, unknown> {
  return {
    functionDeclarations: defs.map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    })),
  };
}

/**
 * Streams a single agentic turn using the Gemini generateContent API.
 * Stateless — history is replayed from DB on each turn.
 * Within a turn, accumulated model responses (function calls) are carried
 * in providerState so subsequent tool-result iterations work correctly.
 *
 * Note: Interactions API (previous_interaction_id) is not yet available in
 * @google/genai v1.x — full stateful continuation will be added when it ships.
 */
async function* streamGeminiAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
  const apiKey = await getResolvedGeminiApiKey(req.userId, req.modelName);
  const ai = new GoogleGenAI({ apiKey });

  const loopState = parseGeminiLoopState(req.providerState);
  const tools =
    (req.toolDefinitions ?? []).length > 0 ? [toolDefsToGemini(req.toolDefinitions!)] : undefined;

  // Build full contents:
  //   1. DB history (text-only for now)
  //   2. In-memory loop turns from this agent turn (if any)
  //   3. Current user prompt OR tool results
  const contents: Content[] = [];

  for (const turn of req.history) {
    contents.push({
      role: turn.role === 'ai' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    });
  }

  // Append accumulated in-loop turns (model function calls + previous tool results)
  if (loopState?.loopContents) {
    for (const lc of loopState.loopContents) {
      contents.push({ role: lc.role as string, parts: lc.parts as Part[] });
    }
  }

  // Add the current turn input
  if (req.toolResults && req.toolResults.length > 0) {
    contents.push({
      role: 'user',
      parts: req.toolResults.map((tr) => {
        let parsed: Record<string, unknown>;
        try {
          const v = JSON.parse(tr.result);
          parsed =
            typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v };
        } catch {
          parsed = { raw: tr.result };
        }
        return {
          functionResponse: {
            id: tr.callId,
            name: tr.name,
            response: parsed,
          },
        } as Part;
      }),
    });
  } else if (req.prompt) {
    contents.push({ role: 'user', parts: [{ text: req.prompt }] });
  }

  const config: Record<string, unknown> = {};
  if (req.systemPrompt?.trim()) config.systemInstruction = req.systemPrompt;
  if (tools) config.tools = tools;

  if (req.generationConfig?.thinkingEnabled) {
    const levelMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } as const;
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: levelMap[req.generationConfig.reasoningEffort] ?? 'MEDIUM',
    };
  }

  try {
    const response = await ai.models.generateContent({
      model: req.modelName,
      contents,
      config,
    });

    const candidate = response.candidates?.[0];

    if (!candidate?.content?.parts) {
      yield { type: 'turn_error', error: 'No response from Gemini' };
      return;
    }

    // Yield agent events for the streaming UI and track callIds for tool execution.
    // Preserve raw parts from the API response for loopContents — Gemini 2.5+
    // requires thought parts with thoughtSignature to be replayed faithfully.
    const rawModelParts: unknown[] = candidate.content.parts;

    for (const part of candidate.content.parts) {
      const p = part as Record<string, any>;

      if (p.thought && p.text) {
        yield { type: 'reasoning_delta', text: p.text as string };
      } else if (p.functionCall) {
        const callId: string =
          (p.functionCall.id as string | undefined) ??
          `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const name: string = (p.functionCall.name as string) ?? '';
        const argsStr = JSON.stringify(p.functionCall.args ?? {});
        yield { type: 'tool_call_started', callId, name };
        yield { type: 'tool_call_completed', callId, name, arguments: argsStr };
      } else if (p.text) {
        yield { type: 'assistant_text_delta', text: p.text as string };
      }
    }

    // Build the updated loop state to return in providerState
    const newLoopContents = [
      ...(loopState?.loopContents ?? []),
      ...(req.toolResults && req.toolResults.length > 0
        ? [
            {
              role: 'user',
              parts: req.toolResults.map((tr) => ({
                functionResponse: {
                  id: tr.callId,
                  name: tr.name,
                  response: (() => {
                    try {
                      return JSON.parse(tr.result) as unknown;
                    } catch {
                      return { raw: tr.result };
                    }
                  })(),
                },
              })),
            },
          ]
        : req.prompt
          ? [{ role: 'user', parts: [{ text: req.prompt }] }]
          : []),
      { role: 'model', parts: rawModelParts },
    ];

    const newProviderState: GeminiLoopState = {
      provider: 'gemini',
      loopContents: newLoopContents,
    };

    yield { type: 'turn_completed', providerState: JSON.stringify(newProviderState) };
  } catch (err: unknown) {
    yield {
      type: 'turn_error',
      error: err instanceof Error ? err.message : 'Gemini request failed',
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
