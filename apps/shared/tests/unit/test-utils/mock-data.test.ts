import { describe, expect, it } from 'vitest';
import {
  MOCK_MODELS,
  createMockChat,
  createMockMessage,
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
    const timestamp = new Date('2026-03-24T12:00:00.000Z');
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

  it('serializes chat and message dates for API responses', () => {
    const chat = createMockChat({
      id: 'chat-iso',
      createdAt: 1_711_280_000_000,
      updatedAt: 1_711_280_123_000,
    });
    const message = createMockMessage({
      id: 'msg-iso',
      timestamp: new Date('2026-03-24T12:34:56.000Z'),
    });

    // Chat timestamps are already epoch ms numbers — the API stores and returns them as numbers.
    expect(toApiResponse.chat(chat)).toEqual({
      ...chat,
      createdAt: 1_711_280_000_000,
      updatedAt: 1_711_280_123_000,
    });
    // Message timestamp is converted from Date to epoch ms number to match GeneratedMessage contract.
    expect(toApiResponse.message(message)).toEqual({
      ...message,
      timestamp: new Date('2026-03-24T12:34:56.000Z').getTime(),
    });
  });
});
