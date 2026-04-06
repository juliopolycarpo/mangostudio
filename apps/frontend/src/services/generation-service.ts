/* global console */
import type { Message } from '@mangostudio/shared';
import { client } from '../lib/api-client';
import { getApiBaseUrl } from '../lib/api-base-url';

export interface GenerateImageRequest {
  chatId: string;
  prompt: string;
  systemPrompt?: string;
  referenceImageUrl?: string;
  imageQuality?: string;
  model: string;
}

export interface GenerateImageResponse {
  userMessage: Message;
  aiMessage: Message;
}

export interface RespondTextRequest {
  chatId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
}

export interface RespondTextResponse {
  userMessage: Message;
  aiMessage: Message;
}

export async function uploadReferenceImage(file: File): Promise<string | null> {
  try {
    const { data, error } = await client.api.upload.post({ image: file });
    if (error) {
      console.error('Failed to upload reference image', error);
      return null;
    }
    return (data as { imageUrl?: string } | null | undefined)?.imageUrl ?? null;
  } catch (error) {
    console.error('Failed to upload reference image', error);
    return null;
  }
}

export async function generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse> {
  const { data, error } = await client.api.generate.post(request);

  if (error) {
    throw new Error((error.value as { error?: string } | null)?.error || 'Image generation failed');
  }

  // Eden Treaty infers a union that includes the error shape even after the guard above.
  // The double cast is intentional and safe here.
  return data as unknown as GenerateImageResponse;
}

export async function respondText(request: RespondTextRequest): Promise<RespondTextResponse> {
  const { data, error } = await client.api.respond.post(request);

  if (error) {
    throw new Error((error.value as { error?: string } | null)?.error || 'Text generation failed');
  }

  // Eden Treaty infers a union that includes the error shape even after the guard above.
  // The double cast is intentional and safe here.
  return data as unknown as RespondTextResponse;
}

/** A single event received from the SSE streaming endpoint. */
export interface StreamChunk {
  type?:
    | 'text'
    | 'thinking'
    | 'thinking_start'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'tool_result'
    | 'context_info'
    | 'fallback_notice'
    | 'system_event'
    | 'done'
    | 'error';
  // text / thinking
  text?: string;
  // tool call events
  callId?: string;
  name?: string;
  arguments?: string;
  result?: unknown;
  isError?: boolean;
  // context_info event fields
  estimatedInputTokens?: number;
  contextLimit?: number;
  estimatedUsageRatio?: number;
  mode?: 'stateful' | 'replay' | 'compacted' | 'degraded';
  severity?: 'normal' | 'info' | 'warning' | 'danger' | 'critical';
  // fallback_notice event fields
  from?: string;
  to?: string;
  reason?: string;
  // system_event fields
  event?: string;
  detail?: string;
  // terminal fields
  done: boolean;
  messageId?: string;
  generationTime?: string;
  error?: string;
}

/**
 * Calls POST /api/respond/stream and invokes onChunk for each SSE event.
 * Throws if the request fails or the stream sends an error event.
 *
 * @param request - Same body as respondText.
 * @param onChunk - Called for every parsed SSE data event.
 * @param signal - Optional AbortSignal to cancel the stream.
 */
export async function respondTextStream(
  request: RespondTextRequest,
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    let message = 'Stream request failed';
    try {
      const body = (await response.json()) as unknown as { error?: string };
      message = body.error ?? message;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  if (!response.body) throw new Error('Stream response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const chunk = JSON.parse(line.slice(6)) as StreamChunk;
            onChunk(chunk);
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
