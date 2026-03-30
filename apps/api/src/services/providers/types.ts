/**
 * Core types for the AI provider abstraction layer.
 */

import type { ProviderType } from '@mangostudio/shared/types';

/** Minimal message shape for text generation context. */
export interface TextContextMessage {
  role: 'user' | 'ai';
  text: string;
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
}

/** Output from text generation. */
export interface TextGenerationResult {
  text: string;
}

/** A single chunk yielded during streaming text generation. */
export interface StreamingTextChunk {
  text: string;
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
  capabilities: {
    text: boolean;
    image: boolean;
    streaming: boolean;
  };
}

/**
 * Contract that all AI provider adapters must implement.
 * Optional methods (generateTextStream, generateImage) may be absent
 * when the underlying provider does not support the capability.
 */
export interface AIProvider {
  readonly providerType: ProviderType;
  generateText(req: TextGenerationRequest): Promise<TextGenerationResult>;
  generateTextStream?(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk>;
  generateImage?(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
  listModels(userId: string): Promise<ModelInfo[]>;
  validateApiKey(apiKey: string): Promise<void>;
  resolveApiKey(userId: string, modelName?: string): Promise<string>;
}
