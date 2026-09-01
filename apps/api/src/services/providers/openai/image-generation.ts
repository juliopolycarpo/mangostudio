/**
 * OpenAI DALL-E image generation.
 */

import type OpenAI from 'openai';
import {
  normalizeGeneratedImageMimeType,
  saveGeneratedImage,
} from '../../generated-images/generated-image-storage';
import { isImageModelId } from '../core/capability-detector';
import type { ImageGenerationRequest, ImageGenerationResult } from '../types';

interface OpenAIClientRuntimeLike {
  readonly client: OpenAI;
}

interface GenerateImageWithOpenAIClientOptions {
  validateModelBeforeRuntime?: boolean;
}

function alwaysReturnsBase64(modelName: string): boolean {
  const id = modelName.toLowerCase();
  return id.startsWith('gpt-image') || id.startsWith('chatgpt-image');
}

export async function generateOpenAIImage(
  client: OpenAI,
  req: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  if (!isImageModelId(req.modelName)) {
    throw new Error(`Image generation is not supported by model "${req.modelName}".`);
  }

  const returnsBase64 = alwaysReturnsBase64(req.modelName);

  // GPT image models always return base64 and reject response_format.
  const params: OpenAI.Images.ImageGenerateParamsNonStreaming = returnsBase64
    ? { model: req.modelName, prompt: req.prompt, size: '1024x1024' }
    : {
        model: req.modelName,
        prompt: req.prompt,
        size: '1024x1024',
        n: 1,
        response_format: 'url',
      };

  const response = await client.images.generate(params, { signal: req.signal });

  const data = response.data?.[0];

  if (data?.b64_json) {
    return {
      imageUrl: await saveGeneratedImage({
        data: data.b64_json,
        encoding: 'base64',
        mimeType: 'image/png',
      }),
    };
  }
  if (data?.url) {
    const imageResponse = await fetch(data.url, { signal: req.signal });
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
  }
  throw new Error(`No image data returned from OpenAI API for model "${req.modelName}".`);
}

export async function generateImageWithOpenAIClient<Runtime extends OpenAIClientRuntimeLike>(
  prepareRuntime: (userId: string, modelName?: string) => Promise<Runtime>,
  req: ImageGenerationRequest,
  options: GenerateImageWithOpenAIClientOptions = {}
): Promise<ImageGenerationResult> {
  if (options.validateModelBeforeRuntime && !isImageModelId(req.modelName)) {
    throw new Error(`Image generation is not supported by model "${req.modelName}".`);
  }

  const { client } = await prepareRuntime(req.userId, req.modelName);
  return generateOpenAIImage(client, req);
}
