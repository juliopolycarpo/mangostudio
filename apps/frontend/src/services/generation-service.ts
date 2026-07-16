/* global console */
import type { GenerateImageResponse } from '@mangostudio/shared';
import type { GenerateImageBody, RespondStreamBody } from '@mangostudio/shared/generation';
import { en } from '@mangostudio/shared/i18n';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import { getApiBaseUrl } from '../lib/api-base-url';
import { client } from '../lib/api-client';

export type GenerateImageRequest = Omit<GenerateImageBody, 'model'> & { model: string };
export type RespondTextRequest = RespondStreamBody;

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
    throw new Error(
      (error.value as { error?: string } | null)?.error || en.errors.imageGenerationFailed
    );
  }

  // Eden Treaty infers a union that includes the error shape even after the guard above.
  // The double cast is intentional and safe here.
  return data as unknown as GenerateImageResponse;
}

export type { StreamChunk };

function recoveryActionError(error: unknown): Error {
  const value = (error as { value?: { error?: string } } | null)?.value;
  return new Error(value?.error ?? en.errors.streamRequestFailed);
}

export async function cancelInterruptedTurn(chatId: string, messageId: string): Promise<void> {
  const { error } = await client.api
    .chats({ id: chatId })
    .messages({ messageId })
    .recovery.cancel.post();
  if (error) throw recoveryActionError(error);
}

export async function dismissInterruptedTurn(chatId: string, messageId: string): Promise<void> {
  const { error } = await client.api
    .chats({ id: chatId })
    .messages({ messageId })
    .recovery.dismiss.post();
  if (error) throw recoveryActionError(error);
}

/**
 * Calls POST /api/respond/stream and invokes onChunk for each SSE event.
 * Throws if the HTTP request fails or the response has no body; error events
 * carried inside the stream are delivered through onChunk like any other chunk.
 *
 * @param request - Text generation request payload sent as the POST body.
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
    let message = en.errors.streamRequestFailed;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  if (!response.body) throw new Error(en.errors.streamResponseNoBody);
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
