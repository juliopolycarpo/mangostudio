import { faker } from '@faker-js/faker';
import type { AuthUser } from '../auth/contracts';
import type {
  Chat,
  GalleryItem,
  GeneratedImageArtifact,
  Message,
  SecretMetadataRow,
} from '../types';

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

/** Call once at the top of a test file for deterministic faker output. */
export function seedFaker(seed: number): void {
  faker.seed(seed);
}

export function createMockUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email({ provider: 'mangostudio.test' }),
    emailVerified: false,
    ...overrides,
  };
}

export function createMockChat(overrides: Partial<Chat> = {}): Chat {
  const now = Date.now();
  return {
    id: faker.string.uuid(),
    title: faker.lorem.words(3),
    createdAt: now - 1000,
    updatedAt: now,
    model: null,
    textModel: MOCK_MODELS.text.id,
    imageModel: MOCK_MODELS.image.id,
    runner: { kind: 'mangostudio', agentId: 'default' },
    runnerPermissions: {},
    runnerModelSelection: {},
    workdir: null,
    environmentId: 'local',
    restrictToolsToWorkdir: null,
    ...overrides,
  };
}

export function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: faker.string.uuid(),
    chatId: faker.string.uuid(),
    role: 'user',
    text: faker.lorem.sentence(),
    interactionMode: 'chat',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Converts internal models to API-compatible JSON structures.
 * Timestamps are already epoch ms numbers — no conversion needed.
 */
export const toApiResponse = {
  chat: (chat: Chat) => ({ ...chat }),
  message: (msg: Message) => ({ ...msg }),
};

export function createMockGeneratedImageArtifact(
  overrides: Partial<GeneratedImageArtifact> = {}
): GeneratedImageArtifact {
  return {
    id: faker.string.uuid(),
    chatId: faker.string.uuid(),
    messageId: faker.string.uuid(),
    prompt: faker.lorem.sentence(),
    imageUrl: `/images/${faker.system.fileName({ extensionCount: 0 })}.png`,
    createdAt: Date.now(),
    ...overrides,
  };
}

export function createMockGalleryItem(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return createMockGeneratedImageArtifact(overrides);
}

export function createMockSecretMetadataRow(
  overrides: Partial<SecretMetadataRow> = {}
): SecretMetadataRow {
  const now = Date.now();
  return {
    id: faker.string.uuid(),
    name: faker.company.name(),
    provider: 'gemini',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: faker.string.alphanumeric(4),
    updatedAt: now,
    lastValidatedAt: now - 60_000,
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
