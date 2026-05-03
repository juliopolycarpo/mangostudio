/**
 * OpenAI DALL-E image generation.
 */

import type OpenAI from 'openai';
import type { ImageGenerationRequest, ImageGenerationResult } from '../types';
import { isImageModelId } from '../core/capability-detector';
import {
  normalizeGeneratedImageMimeType,
  saveGeneratedImage,
} from '../../generated-images/generated-image-storage';

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

  const data = response.data?.[0];

  if (data?.b64_json) {
    return {
      imageUrl: await saveGeneratedImage({
        data: data.b64_json,
        encoding: 'base64',
        mimeType: 'image/png',
      }),
    };
  } else if (data?.url) {
    const imageResponse = await fetch(data.url);
    if (!imageResponse.ok) {
      throw new Error('Failed to download generated image from OpenAI CDN.');
    }
    const mimeType = normalizeGeneratedImageMimeType(
      imageResponse.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    );

    return {
      imageUrl: await saveGeneratedImage({
        data: await imageResponse.arrayBuffer(),
        mimeType,
      }),
    };
  } else {
    throw new Error(`No image data returned from OpenAI API for model "${req.modelName}".`);
  }
}
