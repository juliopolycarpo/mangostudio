/**
 * Gemini image generation service.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../../../lib/config';
import {
  normalizeGeneratedImageMimeType,
  saveGeneratedImage,
} from '../../generated-images/generated-image-storage';
import { createGeminiClient } from './client';
import { getResolvedGeminiApiKey } from './secret';

interface GeminiImagePart {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
}

interface GeminiImageResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: ReadonlyArray<{
    finishReason?: unknown;
    content?: { parts?: ReadonlyArray<GeminiImagePart> };
  }>;
  text?: string;
}

function assertGeminiImageResponse(response: GeminiImageResponse): void {
  if (response.promptFeedback?.blockReason) {
    throw new Error(`Prompt blocked: ${response.promptFeedback.blockReason}`);
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  const finishReasonLabel = formatGeminiFinishReason(finishReason);
  if (finishReasonLabel && finishReasonLabel !== 'STOP') {
    throw new Error(`Generation stopped: ${finishReasonLabel}`);
  }
}

function formatGeminiFinishReason(finishReason: unknown): string | null {
  if (typeof finishReason === 'string') return finishReason;
  if (typeof finishReason === 'number' || typeof finishReason === 'boolean') {
    return `${finishReason}`;
  }
  return null;
}

function findGeminiInlineImage(
  response: GeminiImageResponse
): GeminiImagePart['inlineData'] | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.find((part) => part.inlineData?.data)?.inlineData ?? null;
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function saveGeminiGeneratedImageFromResponse(
  response: GeminiImageResponse
): Promise<string> {
  assertGeminiImageResponse(response);

  const inlineImage = findGeminiInlineImage(response);
  if (inlineImage?.data) {
    return saveGeneratedImage({
      data: inlineImage.data,
      encoding: 'base64',
      mimeType: inlineImage.mimeType
        ? normalizeGeneratedImageMimeType(inlineImage.mimeType)
        : 'image/png',
    });
  }

  if (response.text) throw new Error(`Model returned text instead of image: ${response.text}`);
  throw new Error('No image returned from Gemini');
}

/**
 * Generates an image using the Gemini API.
 *
 * @param userId - The user ID for key resolution.
 * @param prompt - The user's text prompt.
 * @param systemPrompt - Optional system instruction for the model.
 * @param referenceImageUrl - Optional local URL to a reference image (e.g., /uploads/...).
 * @param imageSize - Image quality/size setting (512px, 1K, 2K, 4K).
 * @param modelName - Gemini model to use.
 * @returns The saved image URL path (e.g., /images/generated-xxx.png).
 */
export async function generateGeminiImage(
  userId: string,
  prompt: string,
  systemPrompt?: string,
  referenceImageUrl?: string,
  imageSize = '1K',
  modelName?: string,
  client?: ReturnType<typeof createGeminiClient>
): Promise<string> {
  if (!modelName) {
    throw new Error('No Gemini image model was provided.');
  }

  const ai = client ?? createGeminiClient(await getResolvedGeminiApiKey(userId, modelName));

  const uploadsDir = getConfig().uploads.dir;

  const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
    { text: prompt },
  ];

  if (referenceImageUrl) {
    let base64Data: string;
    let mimeType = 'image/png';

    if (referenceImageUrl.startsWith('/uploads/')) {
      const filePath = join(uploadsDir, referenceImageUrl.replace('/uploads/', ''));
      if (existsSync(filePath)) {
        const buffer = readFileSync(filePath);
        base64Data = buffer.toString('base64');

        const ext = filePath.split('.').pop()?.toLowerCase();
        if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'webp') mimeType = 'image/webp';
      } else {
        console.warn(`[gemini] Reference image not found: ${filePath}`);
        base64Data = '';
      }
    } else if (referenceImageUrl.startsWith('data:image')) {
      base64Data = referenceImageUrl.includes(',')
        ? referenceImageUrl.split(',')[1]
        : referenceImageUrl;
      mimeType = referenceImageUrl.includes('data:')
        ? referenceImageUrl.split(';')[0].split(':')[1]
        : 'image/jpeg';
    } else {
      base64Data = '';
    }

    if (base64Data) {
      parts.unshift({ inlineData: { data: base64Data, mimeType } });
    }
  }

  const config: Record<string, unknown> = {};

  if (systemPrompt?.trim()) {
    config.systemInstruction = systemPrompt;
  }

  if (
    modelName === 'gemini-3.1-flash-image-preview' ||
    modelName === 'gemini-3-pro-image-preview'
  ) {
    let finalImageSize = imageSize;
    if (modelName === 'gemini-3-pro-image-preview' && imageSize === '512px') {
      finalImageSize = '1K';
    }
    config.imageConfig = { aspectRatio: '1:1', imageSize: finalImageSize };
  } else if (modelName === 'gemini-2.5-flash-image') {
    config.imageConfig = { aspectRatio: '1:1' };
  }

  const response = await ai.models.generateContent({
    model: modelName,
    contents: { parts },
    config,
  });

  return saveGeminiGeneratedImageFromResponse(response);
}
