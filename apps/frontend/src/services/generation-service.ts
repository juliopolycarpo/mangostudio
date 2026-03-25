/* global console */
import type { Message } from '@mangostudio/shared';
import { client } from '../lib/api-client';

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
    throw new Error((error.value as any)?.error || 'Image generation failed');
  }

  return data as unknown as GenerateImageResponse;
}

export async function respondText(request: RespondTextRequest): Promise<RespondTextResponse> {
  const { data, error } = await client.api.respond.post(request);

  if (error) {
    throw new Error((error.value as any)?.error || 'Text generation failed');
  }

  return data as unknown as RespondTextResponse;
}
