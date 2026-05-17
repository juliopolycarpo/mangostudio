import { describe, expect, it } from 'bun:test';
import {
  createMockChat,
  createMockGalleryItem,
  createMockGeneratedImageArtifact,
  createMockMessage,
  createMockSecretMetadataRow,
  MOCK_MODELS,
  toApiResponse,
} from '../../../src/test-utils/mock-data';

describe('mock-data test utils', () => {
  it('creates a valid mock chat shape', () => {
    const chat = createMockChat({ id: 'chat-123' });

    expect(chat).toMatchObject({
      id: 'chat-123',
      title: 'Test Chat',
      textModel: MOCK_MODELS.text.id,
      imageModel: MOCK_MODELS.image.id,
    });
    expect(typeof chat.createdAt).toBe('number');
    expect(typeof chat.updatedAt).toBe('number');
    expect(chat.updatedAt).toBeGreaterThanOrEqual(chat.createdAt);
  });

  it('creates a valid mock message shape', () => {
    const timestamp = Date.now();
    const message = createMockMessage({ id: 'msg-123', timestamp });

    expect(message).toMatchObject({
      id: 'msg-123',
      chatId: 'chat-1',
      role: 'user',
      text: 'Hello, world!',
      interactionMode: 'chat',
    });
    expect(message.timestamp).toBe(timestamp);
  });

  it('serializes chat and message timestamps for API responses', () => {
    const chat = createMockChat({
      id: 'chat-iso',
      createdAt: 1_711_280_000_000,
      updatedAt: 1_711_280_123_000,
    });
    const ts = 1_711_280_096_000;
    const message = createMockMessage({ id: 'msg-iso', timestamp: ts });

    expect(toApiResponse.chat(chat)).toEqual({
      ...chat,
      createdAt: 1_711_280_000_000,
      updatedAt: 1_711_280_123_000,
    });
    expect(toApiResponse.message(message)).toEqual({ ...message, timestamp: ts });
  });

  it('creates a valid mock generated image artifact shape', () => {
    const artifact = createMockGeneratedImageArtifact({
      id: 'artifact-123',
      prompt: 'A red apple',
    });

    expect(artifact).toMatchObject({
      id: 'artifact-123',
      chatId: 'chat-1',
      messageId: 'msg-1',
      prompt: 'A red apple',
      imageUrl: '/images/test-image.png',
    });
    expect(typeof artifact.createdAt).toBe('number');
  });

  it('creates a valid mock gallery item shape', () => {
    const item = createMockGalleryItem({
      id: 'gallery-123',
      prompt: 'A blue ocean',
    });

    expect(item).toMatchObject({
      id: 'gallery-123',
      chatId: 'chat-1',
      messageId: 'msg-1',
      prompt: 'A blue ocean',
      imageUrl: '/images/test-image.png',
    });
  });

  it('creates a valid mock secret metadata row shape', () => {
    const row = createMockSecretMetadataRow({
      id: 'connector-123',
      name: 'Test Connector',
      provider: 'openai',
    });

    expect(row).toMatchObject({
      id: 'connector-123',
      name: 'Test Connector',
      provider: 'openai',
      configured: 1,
      source: 'bun-secrets',
      maskedSuffix: '1234',
      userId: null,
      baseUrl: null,
      enabledModels: JSON.stringify(['gemini-pro', 'gemini-flash']),
    });
    expect(typeof row.updatedAt).toBe('number');
    expect(typeof row.lastValidatedAt).toBe('number');
    expect(row.lastValidationError).toBeNull();
  });
});
