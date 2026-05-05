import type { ProviderType } from './provider';

/**
 * Normalized reason for a continuation degradation event.
 * Used in both persisted MessageParts and live SSE events.
 */
export type ContinuationReasonCode =
  | 'provider_changed'
  | 'model_changed'
  | 'system_prompt_changed'
  | 'toolset_changed'
  | 'cursor_expired'
  | 'cursor_invalid'
  | 'tool_result_cursor_loss'
  | 'envelope_malformed';

/** A single event emitted during an agentic turn (streaming tool loop). */
export type AgentEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_started'; callId: string; name?: string }
  | { type: 'tool_call_arguments_delta'; callId: string; delta: string }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError?: boolean }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'turn_completed'; providerState?: string; finishReason?: string }
  | { type: 'turn_error'; error: string }
  | {
      type: 'continuation_degraded';
      from: string;
      to: string;
      reason: string;
      reasonCode: ContinuationReasonCode;
    };

export type GeneratedImageStatus = 'generating' | 'completed' | 'error';

export interface GeneratedImagePart {
  type: 'generated_image';
  imageId: string;
  toolCallId: string;
  status: GeneratedImageStatus;
  prompt: string;
  imageUrl?: string;
  error?: string;
  modelName?: string;
  generationTime?: string;
}

/** Discriminated union of all content block types in an assistant message. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | GeneratedImagePart
  | { type: 'error'; text: string }
  | { type: 'system_event'; event: string; detail?: string }
  | {
      type: 'continuation_transition';
      provider: ProviderType;
      modelName: string;
      fromProvider?: ProviderType;
      fromMode: string;
      toMode: string;
      reasonCode: ContinuationReasonCode;
      detail?: string;
      recovered: boolean;
    };
