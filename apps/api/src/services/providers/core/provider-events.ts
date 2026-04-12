/**
 * Normalized provider event contract.
 *
 * All provider adapters emit these events from their streaming methods.
 * Consumers (routes, application services) receive only ProviderEvent shapes —
 * no provider-specific event semantics leak beyond the provider boundary.
 */

export type ProviderEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking_start'; content?: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; result: unknown }
  | { type: 'system'; event: string; detail?: string }
  | { type: 'context'; inputTokens: number; outputTokens: number; totalTokens?: number }
  | { type: 'error'; message: string; code?: string; recoverable: boolean }
  | { type: 'complete'; providerState?: unknown; model?: string }
  | { type: 'fallback'; reason: string; detail?: string };

export interface ProviderStreamResult {
  events: AsyncIterable<ProviderEvent>;
  abort: () => void;
}
