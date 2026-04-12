/**
 * OpenAI DALL-E image generation.
 */

import type OpenAI from 'openai';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { getConfig } from '../../../lib/config';
import type { ImageGenerationRequest, ImageGenerationResult } from '../types';
import { isImageModelId } from '../core/capability-detector';

export async function generateOpenAIImage(
  client: OpenAI,
  req: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  if (!isImageModelId(req.modelName)) {
    throw new Error(`Image generation is not supported by model "${req.modelName}".`);
  }

  const isGptImage = req.modelName.startsWith('gpt-image');

  // Build model-appropriate params: gpt-image doesn't support `response_format` or `n`
  const params: OpenAI.Images.ImageGenerateParamsNonStreaming = isGptImage
    ? { model: req.modelName, prompt: req.prompt, size: '1024x1024' }
    : {
        model: req.modelName,
        prompt: req.prompt,
        size: '1024x1024',
        n: 1,
        response_format: 'url',
      };

  const response = await client.images.generate(params);

  const uploadsDir = getConfig().uploads.dir;
  mkdirSync(uploadsDir, { recursive: true });

  const filename = `generated-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
  const outputPath = join(uploadsDir, filename);

  const data = response.data?.[0];

  if (data?.b64_json) {
    const imageBuffer = Buffer.from(data.b64_json, 'base64');
    await Bun.write(outputPath, imageBuffer);
  } else if (data?.url) {
    const imageResponse = await fetch(data.url);
    if (!imageResponse.ok) {
      throw new Error('Failed to download generated image from OpenAI CDN.');
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    await Bun.write(outputPath, imageBuffer);
  } else {
    throw new Error(`No image data returned from OpenAI API for model "${req.modelName}".`);
  }

  return { imageUrl: `/uploads/${filename}` };
}
