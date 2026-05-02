/**
 * Core types for the AI provider abstraction layer.
 */

import type {
  MessagePart,
  ReasoningEffort,
  ProviderType,
  AgentEvent,
} from '@mangostudio/shared/types';
import type { PromptCachePreference } from '@mangostudio/shared/provider-settings';

export type { AgentEvent };

/** Minimal message shape for text generation context. */
export interface TextContextMessage {
  role: 'user' | 'ai';
  text: string;
}

/** Rich turn context used in agentic requests — includes parts and providerState. */
export interface ChatTurnContext {
  id: string;
  role: 'user' | 'ai';
  text: string;
  parts?: MessagePart[];
  providerState?: string | null;
  modelName?: string | null;
}

/** Provider-agnostic tool definition (passed to providers that support function calling). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

/**
 * Request for schema-constrained model output.
 *
 * Providers that support native JSON Schema constraints (OpenAI Responses,
 * OpenAI-compatible Chat Completions with `response_format`, Gemini with
 * `response_format`) map this config to their vendor-specific wire format.
 * Providers without native support log a warning and continue unconstrained —
 * see each adapter for its degrade path.
 */
export interface StructuredOutputConfig {
  /** JSON Schema the model output must conform to. */
  schema: Record<string, unknown>;
  /** Schema name — required by OpenAI Responses and Chat Completions. */
  name: string;
  /** When true, enforce strict JSON Schema adherence. Defaults to true at the adapter. */
  strict?: boolean;
}

/** Generation configuration passed through to provider adapters. */
export interface GenerationConfig {
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  tools?: ToolDefinition[];
  maxToolIterations?: number;
  maxOutputTokens?: number;
  promptCachePreference?: PromptCachePreference;
  parallelToolCallsEnabled?: boolean;
  /** Optional schema constraint for model output. Honored by supporting providers; others warn + continue. */
  structuredOutput?: StructuredOutputConfig;
  /**
   * When true (default), stateful providers may use server-side compaction
   * to reduce context window pressure during long conversations.
   * Set to false to disable provider-level compaction.
   */
  enableProviderCompaction?: boolean;
  /** Ratio used to derive provider-side compaction thresholds for cursor chains. */
  providerCompactionThreshold?: number;
}

/** Request for a single agentic turn — supports tool calling and provider-side continuation. */
export interface AgentTurnRequest {
  userId: string;
  modelName: string;
  systemPrompt?: string;
  /** Full persisted chat history (used when no valid cursor is available). */
  history: ChatTurnContext[];
  /** New user prompt — present only on the first iteration of a turn. */
  prompt?: string;
  /** Tool results to feed back — present on subsequent iterations (after tool execution). */
  toolResults?: Array<{
    callId: string;
    name: string;
    result: string;
    isError?: boolean;
  }>;
  toolDefinitions?: ToolDefinition[];
  /**
   * Raw provider state for the current call. Carries one of:
   *
   * - `durableProviderState` (AgentTurnExecutionState): a continuation envelope
   *   with a server-side cursor that survives across user turns (OpenAI
   *   Responses, Gemini Interactions).
   * - `turnLocalState` (AgentTurnExecutionState): accumulated in-memory
   *   messages exchanged within a single agentic turn, never persisted across
   *   turns (Anthropic, OpenAI-compatible).
   *
   * These two roles are documented in AgentTurnExecutionState
   * (core/continuation-envelope).
   */
  providerState?: string | null;
  signal?: AbortSignal;
  generationConfig?: GenerationConfig;
}

/** Input for text generation. */
export interface TextGenerationRequest {
  userId: string;
  history: TextContextMessage[];
  prompt: string;
  systemPrompt?: string;
  modelName: string;
  /** Optional signal to cancel the generation mid-stream. */
  signal?: AbortSignal;
  generationConfig?: GenerationConfig;
  providerState?: string; // for cross-turn continuity
}

/** Output from text generation. */
export interface TextGenerationResult {
  text: string;
  parts?: MessagePart[];
  providerState?: string;
}

/** A single chunk yielded during streaming — now type-discriminated. */
export interface StreamingChunk {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error';
  text?: string;
  toolCallId?: string;
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  done: boolean;
}

/** Input for image generation. */
export interface ImageGenerationRequest {
  userId: string;
  prompt: string;
  systemPrompt?: string;
  referenceImageUrl?: string;
  imageSize?: string;
  modelName: string;
}

/** Output from image generation. */
export interface ImageGenerationResult {
  imageUrl: string;
}

/** Provider capabilities and metadata for a single model. */
export interface ModelInfo {
  modelId: string;
  displayName: string;
  description?: string;
  provider: ProviderType;
  /** Maximum input tokens accepted by the model (from provider API). */
  inputTokenLimit?: number;
  capabilities: {
    text: boolean;
    image: boolean;
    streaming: boolean;
    reasoning?: boolean;
    tools?: boolean;
    statefulContinuation?: boolean;
    promptCaching?: boolean;
    parallelToolCalls?: boolean;
    reasoningWithTools?: boolean;
    structuredOutput?: boolean;
  };
}

/**
 * Contract that all AI provider adapters must implement.
 * Optional methods (generateTextStream, generateImage, generateAgentTurnStream) may be absent
 * when the underlying provider does not support the capability.
 */
export interface AIProvider {
  readonly providerType: ProviderType;
  generateText(req: TextGenerationRequest): Promise<TextGenerationResult>;
  generateTextStream?(req: TextGenerationRequest): AsyncIterable<StreamingChunk>;
  generateImage?(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
  /**
   * Streams a single agentic turn, emitting AgentEvent items.
   * The orchestrator calls this in a loop until turn_completed with no pending tool calls.
   */
  generateAgentTurnStream?(req: AgentTurnRequest): AsyncIterable<AgentEvent>;
  listModels(userId: string): Promise<ModelInfo[]>;
  invalidateModelCache?(userId?: string): void;
  syncConfigFileConnectors?(userId: string): Promise<void>;
  validateApiKey(apiKey: string): Promise<void>;
  resolveApiKey(userId: string, modelName?: string): Promise<string>;
}
