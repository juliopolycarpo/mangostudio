/**
 * Core types for the AI provider abstraction layer.
 */

import type {
  MessagePart,
  ReasoningEffort,
  ProviderType,
  AgentEvent,
} from '@mangostudio/shared/types';

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

/** Generation configuration passed through to provider adapters. */
export interface GenerationConfig {
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  tools?: ToolDefinition[];
  maxToolIterations?: number;
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
   * Opaque provider state from the previous turn (or previous loop iteration).
   * Stateful providers use this as a cursor; stateless providers use it to carry
   * the accumulated in-memory loop messages.
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

/** @deprecated Use StreamingChunk instead. */
export type StreamingTextChunk = StreamingChunk;

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
