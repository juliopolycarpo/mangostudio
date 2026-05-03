import { afterEach, describe, expect, it, mock } from 'bun:test';
import type OpenAI from 'openai';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { loadConfigForTest, resetConfig } from '../../../../src/lib/config';

const TMP_DIR = join('/tmp', `mango-provider-image-test-${process.pid}`);

const realGeminiClient = await import('../../../../src/services/providers/gemini/client');
const realGeminiSecret = await import('../../../../src/services/providers/gemini/secret');
const realCompatibleClient =
  await import('../../../../src/services/providers/openai-compatible/client');
const realCompatibleResolver =
  await import('../../../../src/services/providers/openai-compatible/resolve-client-config');

function configureImageDirs(): string {
  const imagesDir = join(TMP_DIR, crypto.randomUUID());
  loadConfigForTest({
    images: { dir: imagesDir },
    uploads: { dir: join(TMP_DIR, 'uploads') },
  });
  return imagesDir;
}

afterEach(async () => {
  resetConfig();
  rmSync(TMP_DIR, { recursive: true, force: true });
  mock.restore();
  await mock.module('../../../../src/services/providers/gemini/client', () => realGeminiClient);
  await mock.module('../../../../src/services/providers/gemini/secret', () => realGeminiSecret);
  await mock.module(
    '../../../../src/services/providers/openai-compatible/client',
    () => realCompatibleClient
  );
  await mock.module(
    '../../../../src/services/providers/openai-compatible/resolve-client-config',
    () => realCompatibleResolver
  );
});

describe('generated image provider URLs', () => {
  it('stores OpenAI images under /images', async () => {
    const imagesDir = configureImageDirs();
    const { generateOpenAIImage } =
      await import('../../../../src/services/providers/openai/image-generation');

    const fakeClient = {
      images: {
        generate: () =>
          Promise.resolve({ data: [{ b64_json: Buffer.from('png-data').toString('base64') }] }),
      },
    } as unknown as OpenAI;

    const result = await generateOpenAIImage(fakeClient, {
      userId: 'user-openai',
      prompt: 'make an image',
      modelName: 'gpt-image-1',
    });

    expect(result.imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(join(imagesDir, result.imageUrl.replace('/images/', '')))).toBe(true);
  });

  it('stores OpenAI-compatible images under /images', async () => {
    const imagesDir = configureImageDirs();
    await mock.module(
      '../../../../src/services/providers/openai-compatible/resolve-client-config',
      () => ({
        resolveCompatibleClientConfig: () =>
          Promise.resolve({ apiKey: 'test-key', baseUrl: 'https://example.test/v1' }),
      })
    );
    await mock.module('../../../../src/services/providers/openai-compatible/client', () => ({
      createCompatibleClient: () => ({
        images: {
          generate: () =>
            Promise.resolve({
              data: [{ b64_json: Buffer.from('compat-image').toString('base64') }],
            }),
        },
      }),
    }));

    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible/index');
    if (!openAICompatibleProvider.generateImage) {
      throw new Error('OpenAI-compatible provider does not implement generateImage.');
    }

    const result = await openAICompatibleProvider.generateImage({
      userId: 'user-compat',
      prompt: 'draw a mango',
      modelName: 'gpt-image-1',
    });

    expect(result.imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(join(imagesDir, result.imageUrl.replace('/images/', '')))).toBe(true);
  });

  it('stores Gemini images under /images', async () => {
    const imagesDir = configureImageDirs();
    await mock.module('../../../../src/services/providers/gemini/secret', () => ({
      getResolvedGeminiApiKey: () => Promise.resolve('gemini-test-key'),
    }));
    await mock.module('../../../../src/services/providers/gemini/client', () => ({
      createGeminiClient: () => ({
        models: {
          generateContent: () =>
            Promise.resolve({
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
            }),
        },
      }),
    }));

    const { generateGeminiImage } =
      await import('../../../../src/services/providers/gemini/image-generation');
    const imageUrl = await generateGeminiImage(
      'user-gemini',
      'make a sunset over the ocean',
      undefined,
      undefined,
      '1K',
      'gemini-2.5-flash-image'
    );

    expect(imageUrl.startsWith('/images/')).toBe(true);
    expect(existsSync(join(imagesDir, imageUrl.replace('/images/', '')))).toBe(true);
  });
});
