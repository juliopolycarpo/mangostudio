/**
 * Gemini image generation service.
 */

import { join } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { getResolvedGeminiApiKey } from './secret';
import { getConfig } from '../../../lib/config';
import { createGeminiClient } from './client';

/**
 * Generates an image using the Gemini API.
 *
 * @param userId - The user ID for key resolution.
 * @param prompt - The user's text prompt.
 * @param systemPrompt - Optional system instruction for the model.
 * @param referenceImageUrl - Optional local URL to a reference image (e.g., /uploads/...).
 * @param imageSize - Image quality/size setting (512px, 1K, 2K, 4K).
 * @param modelName - Gemini model to use.
 * @returns The saved image URL path (e.g., /uploads/generated-xxx.png).
 */
export async function generateGeminiImage(
  userId: string,
  prompt: string,
  systemPrompt?: string,
  referenceImageUrl?: string,
  imageSize: string = '1K',
  modelName?: string
): Promise<string> {
  if (!modelName) {
    throw new Error('No Gemini image model was provided.');
  }

  const apiKey = await getResolvedGeminiApiKey(userId, modelName);
  const ai = createGeminiClient(apiKey);

  const uploadsDir = getConfig().uploads.dir;

  const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
    { text: prompt },
  ];

  if (referenceImageUrl) {
    let base64Data: string;
    let mimeType: string = 'image/png';

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

  if (systemPrompt && systemPrompt.trim()) {
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

  if (response.promptFeedback?.blockReason) {
    throw new Error(`Prompt blocked: ${response.promptFeedback.blockReason}`);
  }

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && String(finishReason) !== 'STOP') {
    throw new Error(`Generation stopped: ${finishReason}`);
  }

  for (const part of candidate?.content?.parts || []) {
    if (part.inlineData) {
      if (!part.inlineData.data) continue;
      const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
      const filename = `generated-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
      const filePath = join(uploadsDir, filename);

      mkdirSync(uploadsDir, { recursive: true });
      await Bun.write(filePath, imageBuffer);

      return `/uploads/${filename}`;
    }
  }

  if (response.text) {
    throw new Error(`Model returned text instead of image: ${response.text}`);
  }

  console.error('[gemini] Full response:', JSON.stringify(response, null, 2));
  throw new Error('No image returned from Gemini');
}
