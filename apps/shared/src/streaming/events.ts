/** SSE event: context window usage info, emitted after each turn. */
export interface SSEContextEvent {
  type: 'context_info';
  estimatedInputTokens: number;
  contextLimit: number;
  estimatedUsageRatio: number;
  mode: 'stateful' | 'replay' | 'compacted' | 'degraded';
  severity: 'normal' | 'info' | 'warning' | 'danger' | 'critical';
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
}

/** SSE event: system event timeline marker, persisted in message parts. */
export interface SSESystemEvent {
  type: 'system_event';
  event: string;
  detail?: string;
  done: boolean;
}

/** SSE error event emitted by streaming endpoints when generation fails. */
export interface SSEErrorEvent {
  type: 'error';
  error: string;
  done: true;
}

/**
 * Full discriminated union of all SSE chunks emitted by the streaming endpoint.
 * This is the canonical type — frontend and API both import from here.
 */
export type StreamChunk =
  | { type: 'thinking_start'; done: false }
  | { type: 'thinking'; text: string; done: false }
  | { type: 'text'; text: string; done: false }
  | { type: 'tool_call_started'; callId: string; name: string; done: false }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string; done: false }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean; done: false }
  | {
      type: 'context_info';
      estimatedInputTokens: number;
      contextLimit: number;
      estimatedUsageRatio: number;
      mode: 'stateful' | 'replay' | 'compacted' | 'degraded';
      severity: 'normal' | 'info' | 'warning' | 'danger' | 'critical';
      done: false;
    }
  | { type: 'fallback_notice'; from: string; to: string; reason: string; done: false }
  | { type: 'system_event'; event: string; detail?: string; done: false }
  | { type: 'done'; done: true; messageId?: string; generationTime?: string }
  | SSEErrorEvent;
