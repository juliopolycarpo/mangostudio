import type { ContinuationReasonCode, ProviderType } from '../types';

/** SSE event: context window usage info, emitted after each turn. */
export interface SSEContextEvent {
  type: 'context_info';
  estimatedInputTokens: number;
  contextLimit: number;
  estimatedUsageRatio: number;
  mode: 'stateful' | 'stateless-loop' | 'replay' | 'compacted' | 'degraded';
  severity: 'normal' | 'info' | 'warning' | 'danger' | 'critical';
  done: false;
}

/** SSE event: signals the start of a new thinking segment. */
export interface SSEThinkingStartEvent {
  type: 'thinking_start';
  done: false;
}

/** SSE event: fallback/degradation notice, emitted when continuation mode changes. */
export interface SSEFallbackEvent {
  type: 'fallback_notice';
  from: string;
  to: string;
  reason: string;
  done: false;
}

/** SSE event: system event timeline marker, persisted in message parts. */
export interface SSESystemEvent {
  type: 'system_event';
  event: string;
  detail?: string;
  done: boolean;
}

/** SSE event: typed continuation degradation marker, emitted alongside fallback_notice. */
export interface SSEContinuationTransitionEvent {
  type: 'continuation_transition';
  provider: ProviderType;
  modelName: string;
  fromProvider?: ProviderType;
  fromMode: string;
  toMode: string;
  reasonCode: ContinuationReasonCode;
  detail?: string;
  done: false;
}

/** SSE event: an image placeholder was created for a tool-generated image. */
export interface SSEImageGenerationStartedEvent {
  type: 'image_generation_started';
  imageId: string;
  toolCallId: string;
  prompt: string;
  done: false;
}

/** SSE event: a tool-generated image completed and is available by URL. */
export interface SSEImageGenerationCompletedEvent {
  type: 'image_generation_completed';
  imageId: string;
  toolCallId: string;
  prompt: string;
  imageUrl: string;
  modelName?: string;
  generationTime?: string;
  done: false;
}

/** SSE event: a tool-generated image failed while other turn work may continue. */
export interface SSEImageGenerationFailedEvent {
  type: 'image_generation_failed';
  imageId: string;
  toolCallId: string;
  prompt: string;
  error: string;
  modelName?: string;
  generationTime?: string;
  done: false;
}

/** SSE error event emitted by streaming endpoints when generation fails. */
export interface SSEErrorEvent {
  type: 'error';
  error: string;
  done: true;
}

/** SSE event: persisted user message id for the current streamed turn. */
export interface SSEUserMessageIdEvent {
  type: 'user_message_id';
  messageId: string;
  done: false;
}

/**
 * Full discriminated union of all SSE chunks emitted by the streaming endpoint.
 * This is the canonical type — frontend and API both import from here.
 */
export type StreamChunk =
  | SSEUserMessageIdEvent
  | { type: 'thinking_start'; done: false }
  | { type: 'thinking'; text: string; done: false }
  | { type: 'text'; text: string; done: false }
  | { type: 'tool_call_started'; callId: string; name: string; done: false }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string; done: false }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean; done: false }
  | SSEImageGenerationStartedEvent
  | SSEImageGenerationCompletedEvent
  | SSEImageGenerationFailedEvent
  | {
      type: 'context_info';
      estimatedInputTokens: number;
      contextLimit: number;
      estimatedUsageRatio: number;
      mode: 'stateful' | 'stateless-loop' | 'replay' | 'compacted' | 'degraded';
      severity: 'normal' | 'info' | 'warning' | 'danger' | 'critical';
      done: false;
    }
  | { type: 'fallback_notice'; from: string; to: string; reason: string; done: false }
  | { type: 'system_event'; event: string; detail?: string; done: false }
  | SSEContinuationTransitionEvent
  | { type: 'done'; done: true; messageId?: string; generationTime?: string }
  | SSEErrorEvent;
