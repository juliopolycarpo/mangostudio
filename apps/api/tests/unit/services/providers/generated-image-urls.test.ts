import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { loadConfigForTest, resetConfig } from '../../../../src/lib/config';

const TMP_DIR = join('/tmp', `mango-provider-image-test-${process.pid}`);

function configureImageDirs(): string {
  const imagesDir = join(TMP_DIR, crypto.randomUUID());
  loadConfigForTest({
    images: { dir: imagesDir },
    uploads: { dir: join(TMP_DIR, 'uploads') },
  });
  return imagesDir;
}

afterEach(() => {
  resetConfig();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('generated image provider URLs', () => {
  it('stores OpenAI images under /images', async () => {
    const imagesDir = configureImageDirs();
    const { generateOpenAIImage } = await import(
      '../../../../src/services/providers/openai/image-generation'
    );
    const capture: { params?: OpenAI.Images.ImageGenerateParamsNonStreaming } = {};

    const fakeClient = {
      images: {
        generate: (params: OpenAI.Images.ImageGenerateParamsNonStreaming) => {
          capture.params = params;
          return Promise.resolve({
            data: [{ b64_json: Buffer.from('png-data').toString('base64') }],
          });
        },
      },
    } as unknown as OpenAI;

    const result = await generateOpenAIImage(fakeClient, {
      userId: 'user-openai',
      prompt: 'make an image',
      modelName: 'gpt-image-1',
    });

    expect(result.imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(join(imagesDir, result.imageUrl.replace('/images/', '')))).toBe(true);
    expect(capture.params).toEqual({
      model: 'gpt-image-1',
      prompt: 'make an image',
      size: '1024x1024',
    });
  });

  it('downloads DALL-E image URLs into the images directory', async () => {
    const imagesDir = configureImageDirs();
    const { generateOpenAIImage } = await import(
      '../../../../src/services/providers/openai/image-generation'
    );
    const originalFetch = globalThis.fetch;
    const capture: { params?: OpenAI.Images.ImageGenerateParamsNonStreaming } = {};

    globalThis.fetch = ((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url).toBe('https://cdn.openai.test/generated.jpg');
      return Promise.resolve(
        new Response('jpeg-data', { headers: { 'content-type': 'image/jpeg' } })
      );
    }) as typeof fetch;

    try {
      const fakeClient = {
        images: {
          generate: (params: OpenAI.Images.ImageGenerateParamsNonStreaming) => {
            capture.params = params;
            return Promise.resolve({ data: [{ url: 'https://cdn.openai.test/generated.jpg' }] });
          },
        },
      } as unknown as OpenAI;

      const result = await generateOpenAIImage(fakeClient, {
        userId: 'user-openai',
        prompt: 'make a DALL-E image',
        modelName: 'dall-e-3',
      });

      expect(result.imageUrl.startsWith('/images/')).toBe(true);
      expect(readdirSync(imagesDir)).toEqual([result.imageUrl.replace('/images/', '')]);
      expect(result.imageUrl.endsWith('.jpg')).toBe(true);
      expect(capture.params).toEqual({
        model: 'dall-e-3',
        prompt: 'make a DALL-E image',
        size: '1024x1024',
        n: 1,
        response_format: 'url',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stores OpenAI-compatible client images under /images', async () => {
    const imagesDir = configureImageDirs();
    const { generateOpenAIImage } = await import(
      '../../../../src/services/providers/openai/image-generation'
    );

    const fakeCompatibleClient = {
      images: {
        generate: () =>
          Promise.resolve({ data: [{ b64_json: Buffer.from('compat-image').toString('base64') }] }),
      },
    } as unknown as OpenAI;

    const result = await generateOpenAIImage(fakeCompatibleClient, {
      userId: 'user-compat',
      prompt: 'draw a mango',
      modelName: 'gpt-image-1',
    });

    expect(result.imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(join(imagesDir, result.imageUrl.replace('/images/', '')))).toBe(true);
  });

  it('stores Gemini images under /images', async () => {
    const imagesDir = configureImageDirs();
    const { saveGeminiGeneratedImageFromResponse } = await import(
      '../../../../src/services/providers/gemini/image-generation'
    );

    const imageUrl = await saveGeminiGeneratedImageFromResponse({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from('gemini-image').toString('base64'),
                  mimeType: 'image/png',
                },
              },
            ],
          },
        },
      ],
    });

    expect(imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(join(imagesDir, imageUrl.replace('/images/', '')))).toBe(true);
  });
});
