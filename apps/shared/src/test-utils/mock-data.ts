import type { Chat, Message, GalleryItem, SecretMetadataRow } from '../types';

/**
 * Standard mock models for consistent testing across API and Frontend.
 */
export const MOCK_MODELS = {
  text: {
    id: 'gemini-2.5-flash',
    name: 'models/gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Fast and versatile model for most tasks.',
  },
  image: {
    id: 'gemini-2.0-flash-exp-image',
    name: 'models/gemini-2.0-flash-exp-image',
    displayName: 'Gemini 2.0 Flash (Image)',
    description: 'Specialized for high-quality image generation.',
  },
};

export function createMockChat(overrides: Partial<Chat> = {}): Chat {
  const timestamp = Date.now();
  return {
    id: `chat-${timestamp}`,
    title: 'Test Chat',
    createdAt: timestamp - 1000,
    updatedAt: timestamp,
    textModel: MOCK_MODELS.text.id,
    imageModel: MOCK_MODELS.image.id,
    ...overrides,
  };
}

export function createMockMessage(overrides: Partial<Message> = {}): Message {
  const timestamp = new Date();
  return {
    id: `msg-${timestamp.getTime()}`,
    chatId: 'chat-1',
    role: 'user',
    text: 'Hello, world!',
    interactionMode: 'chat',
    timestamp,
    ...overrides,
  };
}

/**
 * Converts internal models to API-compatible JSON structures (e.g., Date to string).
 */
export const toApiResponse = {
  chat: (chat: Chat) => ({
    ...chat,
    createdAt: new Date(chat.createdAt).toISOString(),
    updatedAt: new Date(chat.updatedAt).toISOString(),
  }),
  message: (msg: Message) => ({
    ...msg,
    timestamp: msg.timestamp.toISOString(),
  }),
};

export function createMockGalleryItem(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: `gallery-${Date.now()}`,
    imageUrl: '/uploads/test-image.png',
    prompt: 'A beautiful landscape',
    chatId: 'chat-1',
    ...overrides,
  };
}

export function createMockSecretMetadataRow(
  overrides: Partial<SecretMetadataRow> = {}
): SecretMetadataRow {
  const timestamp = Date.now();
  return {
    id: 'test-connector-id',
    name: 'Default',
    provider: 'gemini',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: '1234',
    updatedAt: timestamp,
    lastValidatedAt: timestamp - 60000,
    lastValidationError: null,
    enabledModels: JSON.stringify(['gemini-pro', 'gemini-flash']),
    userId: null,
    baseUrl: null,
    ...overrides,
  };
}

export const mockChats: Chat[] = [
  createMockChat({ id: 'chat-1', title: 'First Chat' }),
  createMockChat({ id: 'chat-2', title: 'Second Chat' }),
];

export const mockMessages: Message[] = [
  createMockMessage({
    id: 'msg-1',
    chatId: 'chat-1',
    role: 'user',
    text: 'Hello, how are you?',
    interactionMode: 'chat',
  }),
  createMockMessage({
    id: 'msg-2',
    chatId: 'chat-1',
    role: 'ai',
    text: 'I am doing well, thank you!',
    interactionMode: 'chat',
    modelName: MOCK_MODELS.text.id,
  }),
];

export const mockGalleryItems: GalleryItem[] = [
  createMockGalleryItem({ id: 'gallery-1', prompt: 'A sunset over mountains' }),
  createMockGalleryItem({ id: 'gallery-2', prompt: 'A futuristic city' }),
];
