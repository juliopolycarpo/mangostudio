/* global console */
import type { GenerateImageResponse, GenerateTextResponse } from '@mangostudio/shared';
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

export interface RespondTextRequest {
  chatId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
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

export async function respondText(request: RespondTextRequest): Promise<GenerateTextResponse> {
  const { data, error } = await client.api.respond.post(request);

  if (error) {
    throw new Error((error.value as { error?: string } | null)?.error || 'Text generation failed');
  }

  // Eden Treaty infers a union that includes the error shape even after the guard above.
  // The double cast is intentional and safe here.
  return data as unknown as GenerateTextResponse;
}

/** A single event received from the SSE streaming endpoint — tagged discriminated union. */
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
  | { type: 'error'; error: string; done: true };

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
