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
  | { type: 'continuation_degraded'; from: string; to: string; reason: string };

/** Discriminated union of all content block types in an assistant message. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'error'; text: string }
  | { type: 'system_event'; event: string; detail?: string };
