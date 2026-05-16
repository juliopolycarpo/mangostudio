import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  generateImage,
  ImageProviderNotSupportedError,
} from '../../../../src/modules/generation/application/generate-image';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider, ImageGenerationRequest } from '../../../../src/services/providers/types';
import { ChatNotFoundError } from '../../../../src/modules/chats/domain/chat-ownership';

const TEST_USER = {
  id: 'test-user-generate-image',
  name: 'Generate Image User',
  email: 'generate-image@mangostudio.test',
};

let previousOpenAICompatibleProvider: AIProvider | null = null;

beforeAll(async () => {
  try {
    const now = Date.now();
    await getDb()
      .insertInto('user')
      .values({
        id: TEST_USER.id,
        name: TEST_USER.name,
        email: TEST_USER.email,
        emailVerified: 0,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  } catch {
    // user may already exist from another test in coverage mode
  }
});

afterEach(() => {
  if (previousOpenAICompatibleProvider) {
    registerProvider(previousOpenAICompatibleProvider);
  }
  previousOpenAICompatibleProvider = null;
});

function registerImageProvider(
  capturedRequests: ImageGenerationRequest[],
  responseImageUrl: string
): void {
  try {
    previousOpenAICompatibleProvider = getProvider('openai-compatible');
  } catch {
    previousOpenAICompatibleProvider = null;
  }

  registerProvider({
    providerType: 'openai-compatible',
    generateText: () => Promise.resolve({ text: '' }),
    generateImage: (request) => {
      capturedRequests.push(request);
      return Promise.resolve({ imageUrl: responseImageUrl });
    },
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

function registerNoImageProvider(): void {
  try {
    previousOpenAICompatibleProvider = getProvider('openai-compatible');
  } catch {
    previousOpenAICompatibleProvider = null;
  }

  registerProvider({
    providerType: 'openai-compatible',
    generateText: () => Promise.resolve({ text: '' }),
    // generateImage is undefined
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

async function seedConnector(modelId: string): Promise<void> {
  const now = Date.now();
  try {
    await getDb()
      .insertInto('secret_metadata')
      .values({
        id: `generate-image-connector-${modelId}`,
        name: `Generate Image ${modelId}`,
        provider: 'openai-compatible',
        configured: 1,
        source: 'config-file',
        maskedSuffix: 'test',
        updatedAt: now,
        lastValidatedAt: now,
        lastValidationError: null,
        enabledModels: JSON.stringify([modelId]),
        userId: TEST_USER.id,
        baseUrl: null,
        organizationId: null,
        projectId: null,
      })
      .execute();
  } catch {
    // Ignore unique constraint if already seeded
  }
}

describe('generateImage', () => {
  it('throws ChatNotFoundError if chat does not exist', async () => {
    const db = getDb();
    let caughtError: unknown;
    try {
      await generateImage(
        {
          chatId: 'non-existent-chat',
          userId: TEST_USER.id,
          prompt: 'A cute cat',
          model: 'test-image-model',
        },
        db
      );
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(ChatNotFoundError);
  });

  it('throws ImageProviderNotSupportedError if provider does not support image generation', async () => {
    const db = getDb();
    registerNoImageProvider();

    const now = Date.now();
    const chatId = `generate-image-chat-no-support-${now}`;
    const modelId = `no-support-model-${now}`;
    await seedConnector(modelId);

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Generate Image Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    let caughtError: unknown;
    try {
      await generateImage(
        {
          chatId,
          userId: TEST_USER.id,
          prompt: 'A cute cat',
          model: modelId,
        },
        db
      );
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(ImageProviderNotSupportedError);
  });

  it('generates and persists an image successfully', async () => {
    const db = getDb();
    const capturedRequests: ImageGenerationRequest[] = [];
    registerImageProvider(capturedRequests, 'https://example.com/cat.png');

    const now = Date.now();
    const chatId = `generate-image-chat-success-${now}`;
    const modelId = `success-model-${now}`;
    await seedConnector(modelId);

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Generate Image Chat Success',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const result = await generateImage(
      {
        chatId,
        userId: TEST_USER.id,
        prompt: 'A cute cat',
        model: modelId,
        imageQuality: 'HD',
        systemPrompt: 'You are an artist.',
        referenceImageUrl: 'https://example.com/ref.png',
      },
      db
    );

    // Verify result object
    expect(result.userMessage.text).toBe('A cute cat');
    expect(result.userMessage.referenceImage).toBe('https://example.com/ref.png');
    expect(result.aiMessage.imageUrl).toBe('https://example.com/cat.png');
    expect(result.aiMessage.modelName).toBe(modelId);
    expect(result.aiMessage.generatedImages).toHaveLength(1);
    expect(result.aiMessage.generatedImages[0].imageUrl).toBe('https://example.com/cat.png');

    // Verify provider call
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].prompt).toBe('A cute cat');
    expect(capturedRequests[0].systemPrompt).toBe('You are an artist.');
    expect(capturedRequests[0].imageSize).toBe('HD');
    expect(capturedRequests[0].referenceImageUrl).toBe('https://example.com/ref.png');

    // Verify persistence
    const messages = await db
      .selectFrom('messages')
      .selectAll()
      .where('chatId', '=', chatId)
      .orderBy('timestamp', 'asc')
      .execute();

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('A cute cat');

    expect(messages[1].role).toBe('ai');
    expect(messages[1].text).toBe('');

    const generatedImages = await db
      .selectFrom('generated_images')
      .selectAll()
      .where('messageId', '=', messages[1].id)
      .execute();

    expect(generatedImages).toHaveLength(1);
    expect(generatedImages[0].imageUrl).toBe('https://example.com/cat.png');
    expect(generatedImages[0].modelName).toBe(modelId);
  });
});
