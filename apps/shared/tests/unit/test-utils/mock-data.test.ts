import { describe, expect, it } from 'bun:test';
import {
  createMockChat,
  createMockGalleryItem,
  createMockGeneratedImageArtifact,
  createMockMessage,
  createMockSecretMetadataRow,
  createMockUser,
  MOCK_MODELS,
  seedFaker,
  toApiResponse,
} from '../../../src/test-utils/mock-data';

describe('mock-data test utils', () => {
  it('createMockChat produces a valid chat shape with defaults', () => {
    const chat = createMockChat();

    expect(typeof chat.id).toBe('string');
    expect(chat.id.length).toBeGreaterThan(0);
    expect(typeof chat.title).toBe('string');
    expect(chat.title.length).toBeGreaterThan(0);
    expect(chat.textModel).toBe(MOCK_MODELS.text.id);
    expect(chat.imageModel).toBe(MOCK_MODELS.image.id);
    expect(typeof chat.createdAt).toBe('number');
    expect(typeof chat.updatedAt).toBe('number');
    expect(chat.updatedAt).toBeGreaterThanOrEqual(chat.createdAt);
  });

  it('createMockChat respects overrides', () => {
    const chat = createMockChat({ id: 'chat-123', title: 'My Chat' });

    expect(chat.id).toBe('chat-123');
    expect(chat.title).toBe('My Chat');
    expect(chat.textModel).toBe(MOCK_MODELS.text.id);
  });

  it('createMockMessage produces a valid message shape with defaults', () => {
    const message = createMockMessage();

    expect(typeof message.id).toBe('string');
    expect(typeof message.chatId).toBe('string');
    expect(message.role).toBe('user');
    expect(typeof message.text).toBe('string');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.interactionMode).toBe('chat');
    expect(typeof message.timestamp).toBe('number');
  });

  it('createMockMessage respects overrides', () => {
    const ts = Date.now();
    const message = createMockMessage({ id: 'msg-123', chatId: 'chat-1', timestamp: ts });

    expect(message.id).toBe('msg-123');
    expect(message.chatId).toBe('chat-1');
    expect(message.timestamp).toBe(ts);
  });

  it('toApiResponse passes through chat and message unchanged', () => {
    const chat = createMockChat({
      id: 'chat-iso',
      createdAt: 1_711_280_000_000,
      updatedAt: 1_711_280_123_000,
    });
    const message = createMockMessage({ id: 'msg-iso', timestamp: 1_711_280_096_000 });

    expect(toApiResponse.chat(chat)).toEqual(chat);
    expect(toApiResponse.message(message)).toEqual(message);
  });

  it('createMockGeneratedImageArtifact produces a valid shape', () => {
    const artifact = createMockGeneratedImageArtifact({
      id: 'artifact-123',
      prompt: 'A red apple',
    });

    expect(artifact.id).toBe('artifact-123');
    expect(artifact.prompt).toBe('A red apple');
    expect(typeof artifact.chatId).toBe('string');
    expect(typeof artifact.messageId).toBe('string');
    expect(typeof artifact.imageUrl).toBe('string');
    expect(typeof artifact.createdAt).toBe('number');
  });

  it('createMockGalleryItem produces a valid shape', () => {
    const item = createMockGalleryItem({ id: 'gallery-123', prompt: 'A blue ocean' });

    expect(item.id).toBe('gallery-123');
    expect(item.prompt).toBe('A blue ocean');
    expect(typeof item.chatId).toBe('string');
  });

  it('createMockSecretMetadataRow produces a valid shape', () => {
    const row = createMockSecretMetadataRow({ id: 'connector-123', provider: 'openai' });

    expect(row.id).toBe('connector-123');
    expect(row.provider).toBe('openai');
    expect(row.configured).toBe(1);
    expect(row.source).toBe('bun-secrets');
    expect(typeof row.maskedSuffix).toBe('string');
    expect(row.maskedSuffix?.length).toBe(4);
    expect(typeof row.updatedAt).toBe('number');
    expect(typeof row.lastValidatedAt).toBe('number');
    expect(row.lastValidationError).toBeNull();
  });

  it('createMockUser produces a valid user shape', () => {
    const user = createMockUser();

    expect(typeof user.id).toBe('string');
    expect(user.id.length).toBeGreaterThan(0);
    expect(typeof user.name).toBe('string');
    expect(user.email).toMatch(/@mangostudio\.test$/);
    expect(user.emailVerified).toBe(false);
  });

  it('createMockUser respects overrides', () => {
    const user = createMockUser({ id: 'user-abc', name: 'Alice' });

    expect(user.id).toBe('user-abc');
    expect(user.name).toBe('Alice');
  });

  it('seedFaker makes output deterministic', () => {
    seedFaker(42);
    const a = createMockUser();
    seedFaker(42);
    const b = createMockUser();

    expect(a.id).toBe(b.id);
    expect(a.email).toBe(b.email);
  });
});
